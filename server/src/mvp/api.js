import crypto from 'node:crypto';
// MVP の 1（会員登録・認証・スタッフ）の API と、開催・主催者設定・監査ログ。
// 商品は、競りの最中に進行コンソールからその場で登録する（発注者の決定）ので、事前の登録・審査・カタログは持たない。
// 権限は、必ずここ（サーバーの側）で確かめる。画面でボタンを隠すだけにはしない（本仕様 8.14）。
import fs from 'node:fs';
import path from 'node:path';
import { MVP_SCHEMA, DEFAULT_SETTINGS } from './schema.js';
import {
  randomToken, sha256, safeEqual, hashPassword, verifyPassword, newTotpSecret, verifyTotp, totp, otpauthUrl,
  newOtpCode, normalizePhone, isEmail,
} from './security.js';
import { clientIp } from './security.js';
import { Notifier, outboxSender, httpMailSender } from './notify.js';
import { jpDay, compose, subjectOf } from './mails.js';
import QRCode from 'qrcode';
import { createRequire } from 'node:module';

// 都道府県（住所の入力で選ぶ）
const PREFECTURES = '北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県'.split(' ');
// 郵便番号から住所を引く辞書（日本郵便のデータを収めた部品）。最初に使うときに読み込む
let postalDict = null;
const lookupPostal = (code) => {
  postalDict ??= createRequire(import.meta.url)('jp-zipcode-lookup').Oaza;
  return postalDict.byZipcode(code).map((o) => ({ prefecture: o.pref.name, city: o.city.name, town: o.name }));
};
const toHalfDigits = (v) => String(v ?? '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
// フリガナ: ひらがなで入れても、カタカナに直す
const toKatakana = (v) => String(v ?? '').replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
import { createBilling } from './billing.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OTP_TTL = 5 * MIN;            // 認証番号の有効期限（FR-AUTH-004）
const OTP_MAX_ATTEMPTS = 5;         // 入力の誤り5回で無効
const OTP_SENDS_PER_HOUR = 5;       // 同じ番号へ1時間に5回まで
// 会員: 一度ログインしたら、その端末では、ログインを求めない（発注者の指示）。最後に操作してから 400 日で切れる
// （ブラウザがクッキーを覚えておける上限に合わせた。使っているかぎり、延び続ける）
const MEMBER_IDLE = 400 * DAY;
const LOGIN_FAIL_MAX = 10;          // ログイン ID とパスワードの誤りが続いたら、しばらく止める
const LOGIN_LOCK = 15 * MIN;
const STAFF_LIFETIME = 12 * HOUR;   // スタッフ: 12時間（FR-AUTH-012）
const REGISTER_LIFETIME = 15 * MIN; // SMS 認証から登録の完了まで
const LOCK_AFTER = 5;               // パスワードの誤り5回で
const LOCK_FOR = 15 * MIN;          // 15分ロック
const ROLE_LABEL = { admin: '主催者管理者', auctioneer: '進行役', caller: 'オークショニア', reception: '受付係', operator: '開発・運営者' };

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const bad = (message, extra) => new HttpError(400, message, extra);

export function createApi({ store, config, nowMs, persistStatus = () => null, durable = () => null }) {
  const db = store.db;
  // 以前の版のデータベース: スタッフの役割に「開発・運営者」「オークショニア」を足すには、表を作り直すしかない（SQLite の制約）。行の id は変えない
  const oldStaff = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'staff_accounts'").get();
  if (oldStaff && !oldStaff.sql.includes("'caller'")) {
    db.transaction(() => {
      const old = db.prepare("SELECT name, type, dflt_value, \"notnull\" AS nn FROM pragma_table_info('staff_accounts')").all();
      db.exec('ALTER TABLE staff_accounts RENAME TO staff_accounts_old;');
      db.exec(MVP_SCHEMA);
      // あとから足した列（メールアドレスなど）は、新しい表にも足してから写す
      for (const c of old) {
        if (!db.prepare("SELECT 1 FROM pragma_table_info('staff_accounts') WHERE name = ?").get(c.name)) db.exec(`ALTER TABLE staff_accounts ADD COLUMN ${c.name} ${c.type}${c.nn ? ` NOT NULL DEFAULT ${c.dflt_value ?? 0}` : ''}`);
      }
      const cols = old.map((c) => c.name).join(', ');
      db.exec(`INSERT INTO staff_accounts (${cols}) SELECT ${cols} FROM staff_accounts_old; DROP TABLE staff_accounts_old;`);
    })();
  }
  db.exec('DROP TRIGGER IF EXISTS audit_no_update'); // 前の版の「書き換えを一切許さない」決まり（いまは audit_no_update_v2）
  db.exec(MVP_SCHEMA);
  // スタッフのログインを、メールアドレスとパスワードにする（発注者の指示）。パスワードは、最初のログインで本人が決める。
  // setup_expires: パスワードを決められる期限。password_hash が空のあいだは、パスワードでは入れない（setup_hash は、いまは使わない）
  for (const [col, type] of [['email', 'TEXT'], ['setup_hash', 'TEXT'], ['setup_expires', 'REAL NOT NULL DEFAULT 0']]) {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('staff_accounts') WHERE name = ?").get(col)) db.exec(`ALTER TABLE staff_accounts ADD COLUMN ${col} ${type}`);
  }
  // 承認（発注者の指示）: 会員登録は、主催者管理者が承認するまで「承認待ち」。前からの会員は、承認済みとして扱う
  if (!db.prepare("SELECT 1 FROM pragma_table_info('member_accounts') WHERE name = 'approved_at'").get()) {
    db.exec('ALTER TABLE member_accounts ADD COLUMN approved_at REAL');
    db.exec('ALTER TABLE member_accounts ADD COLUMN rejected_at REAL');
    db.exec('UPDATE member_accounts SET approved_at = created_at');
  }
  // 電話番号が本人のものと確かめてあるか（メールで登録した人は、まだ確かめていない）。前からの会員は、SMS で確かめてある
  if (!db.prepare("SELECT 1 FROM pragma_table_info('member_accounts') WHERE name = 'phone_verified'").get()) db.exec('ALTER TABLE member_accounts ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 1');
  // 電話番号の重なりを禁じるのは、本人のものと確かめた番号（phone_verified = 1）だけにする。メールで登録した人の番号は、まだ確かめていないので、
  // 他人の番号を先に入れて、本人が登録できなくなる（先取り）のを防ぐ（本番運用の評価 C）。前の版の表（phone に UNIQUE）は、作り直す
  const memberSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'member_accounts'").get().sql;
  if (/phone TEXT NOT NULL UNIQUE/.test(memberSql)) {
    const fk = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS member_accounts_new');
      db.exec(memberSql.replace(/CREATE TABLE ("?)member_accounts\1/, 'CREATE TABLE member_accounts_new').replace('phone TEXT NOT NULL UNIQUE', 'phone TEXT NOT NULL'));
      const cols = db.prepare("SELECT name FROM pragma_table_info('member_accounts')").all().map((c) => c.name).join(', ');
      db.exec(`INSERT INTO member_accounts_new (${cols}) SELECT ${cols} FROM member_accounts; DROP TABLE member_accounts; ALTER TABLE member_accounts_new RENAME TO member_accounts;`);
    })();
    db.pragma(`foreign_keys = ${fk ? 'ON' : 'OFF'}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS member_accounts_phone_verified ON member_accounts (phone) WHERE phone_verified = 1');
  db.exec('CREATE INDEX IF NOT EXISTS member_accounts_phone ON member_accounts (phone)');
  for (const [col, type] of [['login_id', 'TEXT'], ['password_hash', 'TEXT'], ['login_failed', 'INTEGER NOT NULL DEFAULT 0'], ['login_locked_until', 'REAL NOT NULL DEFAULT 0'], ['withdrawn_at', 'REAL'], ['withdrawn_phone', 'TEXT'], ['agreed_at', 'REAL'], ['name_kana', 'TEXT'], ['postal_code', 'TEXT'], ['prefecture', 'TEXT'], ['address1', 'TEXT'], ['address2', 'TEXT']]) {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('member_accounts') WHERE name = ?").get(col)) db.exec(`ALTER TABLE member_accounts ADD COLUMN ${col} ${type}`);
  }
  // 以前の版のデータベースに、後から足した列を加える
  if (!db.prepare("SELECT 1 FROM pragma_table_info('email_tokens') WHERE name = 'email'").get()) db.exec('ALTER TABLE email_tokens ADD COLUMN email TEXT');
  for (const col of ['phase', 'resume_at']) if (!db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = ?").get(col)) db.exec(`ALTER TABLE events ADD COLUMN ${col} TEXT`);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = 'venue_code'").get()) db.exec('ALTER TABLE events ADD COLUMN venue_code TEXT');
  if (!db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = 'highlights'").get()) db.exec("ALTER TABLE events ADD COLUMN highlights TEXT NOT NULL DEFAULT ''");
  // 開催のお知らせメールを受け取るか（会員がマイページで切り替える。最初は受け取る）
  if (!db.prepare("SELECT 1 FROM pragma_table_info('member_accounts') WHERE name = 'event_mail'").get()) db.exec('ALTER TABLE member_accounts ADD COLUMN event_mail INTEGER NOT NULL DEFAULT 1');
  // 開催のお知らせメールの受信の同意（特定電子メール法。報告書 96 章）: 同意した時刻と、どこで同意したか。配信を止めるリンクの合言葉
  for (const [col, type] of [['event_mail_consent_at', 'REAL'], ['event_mail_consent_via', 'TEXT'], ['unsub_token', 'TEXT']]) {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('member_accounts') WHERE name = ?").get(col)) db.exec(`ALTER TABLE member_accounts ADD COLUMN ${col} ${type}`);
  }
  // 個人情報を消した時刻（保存期間を過ぎた退会・却下の会員。本番運用の評価 C）
  if (!db.prepare("SELECT 1 FROM pragma_table_info('member_accounts') WHERE name = 'pii_purged_at'").get()) db.exec('ALTER TABLE member_accounts ADD COLUMN pii_purged_at REAL');
  // 開催のお知らせメールを送った記録（同じ開催の同じ会員に、2度送らない）
  db.exec('CREATE TABLE IF NOT EXISTS event_mails (event_id INTEGER NOT NULL, account_id INTEGER NOT NULL, at REAL NOT NULL, PRIMARY KEY (event_id, account_id))');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  // お試し用（認証番号を画面に出す設定）から本番の設定に切り替えたら、お試しのあいだのログインをすべて消し、送ったメールの控えも消す
  // （お試しのあいだに、他人に作られたログインを、本番に持ち込まない。本番運用の評価 A1。報告書 102 章）
  {
    const mode = config.devShowCodes ? 'demo' : 'production';
    const before = db.prepare("SELECT value FROM settings WHERE key = 'run_mode'").get()?.value;
    if (before === 'demo' && mode === 'production') {
      const n = db.prepare('DELETE FROM sessions').run().changes;
      fs.rmSync(path.join(config.dataDir, 'outbox'), { recursive: true, force: true });
      console.log(`[mode] お試し用から本番の設定に切り替わりました。ログイン ${n} 件と、送ったメールの控えを消しました`);
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('run_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(mode);
  }

  const notifier = new Notifier(
    config.mailUrl ? httpMailSender(config.mailUrl, outboxSender(path.join(config.dataDir, 'outbox'))) : outboxSender(path.join(config.dataDir, 'outbox')),
    (failure) => db.prepare('INSERT INTO notices (at, kind, body) VALUES (?, ?, ?)').run(nowMs(), 'send_failed', JSON.stringify(failure)),
    // 本物の送信サービスにつないでいるときは、メールを1通ずつ間隔をあけて送る（本番運用の評価 B11）
    { intervalMs: config.mailUrl ? config.mailIntervalMs : 0 },
  );
  const setting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? '';
  // メールの宛名（法人は、会社名と担当者名）
  const nameOf = (m) => (m.kind === 'b2b' ? [m.company, m.contact_name].filter(Boolean).join('　') || m.name : m.name);

  // ------------------------------------------------------------ 個人情報の保存期間（本番運用の評価 C）
  /**
   * 退会・却下のときに、もう使わないログインの情報を、すぐに消す: パスワードのハッシュ・ログイン ID・お知らせメールの同意と、
   * 配信を止めるリンク・ログイン中の端末・メールの確認のリンク。名前・連絡先は、下の保存期間のあいだ残す（請求・帳簿のため）
   */
  function dropLogin(id) {
    db.prepare('UPDATE member_accounts SET password_hash = NULL, login_id = NULL, login_failed = 0, login_locked_until = 0, event_mail = 0, event_mail_consent_at = NULL, event_mail_consent_via = NULL, unsub_token = NULL WHERE id = ?').run(id);
    db.prepare("DELETE FROM sessions WHERE kind = 'member' AND subject_id = ?").run(id);
    db.prepare('DELETE FROM email_tokens WHERE member_id = ?').run(id);
  }
  // 【前提】保存期間（発注者の確認が要る。プライバシーポリシーに書く）:
  //   却下（取引なし）: 却下から 90 日 / 退会・取引なし: 退会から 1 年 /
  //   退会・取引あり（落札の明細がある）: 退会から 7 年（請求書・帳簿の保存。法人税法の帳簿書類の保存期間に合わせる）
  //   接続元の IP アドレス（監査ログ）: 1 年
  const DAY_MS = 86400000;
  const KEEP = { rejected: 90 * DAY_MS, noTrade: 365 * DAY_MS, trade: 7 * 365 * DAY_MS, ip: 365 * DAY_MS };
  /** 保存期間を過ぎた個人情報を消す（1時間ごとの見回りから呼ぶ）。会員番号・請求の金額・監査ログの記録は残す */
  function purgeExpiredPii() {
    const now = nowMs();
    const due = db.prepare(`SELECT a.id FROM member_accounts a WHERE a.withdrawn_at IS NOT NULL AND a.pii_purged_at IS NULL AND (
        (a.rejected_at IS NOT NULL AND a.withdrawn_at < ?)
        OR (a.rejected_at IS NULL AND NOT EXISTS (SELECT 1 FROM bill_lines l WHERE l.account_id = a.id) AND a.withdrawn_at < ?)
        OR (a.withdrawn_at < ?))`).all(now - KEEP.rejected, now - KEEP.noTrade, now - KEEP.trade);
    const tx = db.transaction((id) => {
      dropLogin(id);
      db.prepare(`UPDATE member_accounts SET name = '（削除済み）', email = '', email_verified = 0, address = '', ship_to = NULL, company = NULL, contact_name = NULL, billing = NULL,
        name_kana = NULL, postal_code = NULL, prefecture = NULL, address1 = NULL, address2 = NULL, withdrawn_phone = NULL, suspend_reason = NULL, pii_purged_at = ? WHERE id = ?`).run(now, id);
      db.prepare("UPDATE members SET name = '（削除済み）' WHERE account_id = ?").run(id);
    });
    for (const { id } of due) tx(id);
    const ip = db.prepare('UPDATE audit_log SET ip = NULL WHERE ip IS NOT NULL AND at < ?').run(now - KEEP.ip).changes;
    if (due.length) audit({ system: true }, 'privacy.purge', { after: { members: due.map((r) => r.id), ip } });
    return { members: due.length, ip };
  }

  // ------------------------------------------------------------ 監査ログ（DATA-001）
  function audit(ctx, type, { target = '', before = null, after = null, reason = null } = {}) {
    const a = ctx.staff ? { kind: 'staff', id: ctx.staff.id, role: ctx.staff.role }
      : ctx.member ? { kind: 'member', id: ctx.member.id, role: 'member' }
      : { kind: ctx.system ? 'system' : 'anonymous', id: null, role: null };
    db.prepare('INSERT INTO audit_log (type, at, actor_kind, actor_id, actor_role, target, before, after, reason, ip) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(type, nowMs(), a.kind, a.id, a.role, target, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), reason, ctx.ip ?? null);
  }

  // ------------------------------------------------------------ セッション
  function setCookie(ctx, token, maxAgeMs) {
    const secure = config.cookieSecure || ctx.req.headers['x-forwarded-proto'] === 'https';
    ctx.res.setHeader('set-cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`);
  }

  // ------------------------------------------------------------ いつもの端末（ロックの締め出しを防ぐ。本番運用の評価 C）
  // ログイン ID（rw＋会員番号）は推測できるので、他人がわざと誤りを続けると、本人がロックで入れなくなる（締め出し）。
  // 一度ログインに成功した端末には、署名した印（クッキー）を渡し、その端末からは、ロックを掛けず・誤りも数えない。
  // ロックは、印のない端末（初めての端末・他人）にだけ掛かる。パスワードの総当たりは、接続元ごとの回数の制限（throttle）でも止まる
  db.exec('CREATE TABLE IF NOT EXISTS app_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO app_secrets (key, value) VALUES (?, ?)').run('device', crypto.randomBytes(32).toString('hex'));
  const deviceKey = db.prepare("SELECT value FROM app_secrets WHERE key = 'device'").get().value;
  const deviceSig = (kind, id) => crypto.createHmac('sha256', deviceKey).update(`${kind}:${id}`).digest('base64url');
  function trustDevice(ctx, kind, id) {
    const secure = config.cookieSecure || ctx.req.headers['x-forwarded-proto'] === 'https';
    const prev = ctx.res.getHeader('set-cookie');
    const add = `dv_${kind}=${id}.${deviceSig(kind, id)}; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=${400 * 24 * 3600}${secure ? '; Secure' : ''}`;
    ctx.res.setHeader('set-cookie', [...(prev ? [prev].flat() : []), add]);
  }
  function trustedDevice(ctx, kind, id) {
    const m = new RegExp(`(?:^|;\\s*)dv_${kind}=(\\d+)\\.([A-Za-z0-9_-]+)`).exec(ctx.req.headers.cookie ?? '');
    if (!m || Number(m[1]) !== id) return false;
    const want = Buffer.from(deviceSig(kind, id)), got = Buffer.from(m[2]);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }
  function startSession(ctx, kind, subjectId, lifetime, phone = null) {
    const token = randomToken();
    db.prepare('INSERT INTO sessions (id_hash, kind, subject_id, phone, created_at, last_seen_at) VALUES (?,?,?,?,?,?)').run(sha256(token), kind, subjectId, phone, nowMs(), nowMs());
    setCookie(ctx, token, lifetime);
  }
  function endSession(ctx) {
    if (ctx.sessionHash) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(ctx.sessionHash);
    ctx.res.setHeader('set-cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  }
  function loadSession(ctx) {
    const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]+)/.exec(ctx.req.headers.cookie ?? '');
    if (!m) return;
    const hash = sha256(m[1]);
    const s = db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(hash);
    if (!s) return;
    const now = nowMs();
    const expired = s.kind === 'member' ? now - s.last_seen_at > MEMBER_IDLE
      : s.kind === 'staff' ? now - s.created_at > STAFF_LIFETIME
      : now - s.created_at > REGISTER_LIFETIME;
    if (expired) { db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hash); return; }
    ctx.sessionHash = hash;
    if (s.kind === 'member') {
      ctx.member = db.prepare('SELECT * FROM member_accounts WHERE id = ?').get(s.subject_id) ?? null;
      // 認証番号でログインした直後（30分以内）は、いまのパスワードなしで、新しいパスワードを決められる（パスワードを忘れた人のため）
      ctx.viaOtp = s.phone === 'otp' && now - s.created_at < 30 * MIN;
      // 最後の操作から30日。毎回は書かず、1時間に1回だけ更新する
      if (now - s.last_seen_at > HOUR) db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, hash);
    } else if (s.kind === 'staff') {
      const staff = db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(s.subject_id);
      if (staff?.active) ctx.staff = staff; // 停止されたスタッフは、その場で使えなくなる
    } else {
      ctx.registerPhone = s.phone;
    }
  }
  const needStaff = (ctx, ...roles) => {
    if (!ctx.staff) throw new HttpError(401, 'スタッフのログインが必要です');
    if (!roles.includes(ctx.staff.role)) throw new HttpError(403, `この操作は、${roles.map((r) => ROLE_LABEL[r]).join('・')}だけができます`);
    return ctx.staff;
  };
  const needMember = (ctx) => { if (!ctx.member) throw new HttpError(401, 'ログインが必要です'); return ctx.member; };

  // ------------------------------------------------------------ 認証の試行の速さ（総当たりを遅くする）
  const attempts = new Map(); // ip -> [時刻…]
  // 種類ごとに数える（住所の検索で、ログインの回数を使い切らないように）
  function throttle(ctx, bucket = 'auth', limit = config.authRatePerMin) {
    if (!(config.authRatePerMin > 0)) return;
    const now = nowMs();
    const key = `${bucket}:${ctx.ip}`;
    if (attempts.size > 20000) for (const [k, v] of attempts) if (!v.some((t) => now - t < MIN)) attempts.delete(k); // たまった古い分を捨てる
    const list = (attempts.get(key) ?? []).filter((t) => now - t < MIN);
    if (list.length >= limit) throw new HttpError(429, '試行が多すぎます。1分ほど待ってから、やり直してください');
    list.push(now);
    attempts.set(key, list);
  }

  // ------------------------------------------------------------ SMS の認証番号（FR-AUTH-004・010）
  // 認証番号を送る。phone は、電話番号か「email:アドレス」（メールでのログイン）
  async function sendOtp(phone) {
    const now = nowMs();
    const sent = db.prepare('SELECT COUNT(*) AS n FROM otp_sends WHERE phone = ? AND at > ?').get(phone, now - HOUR).n;
    if (sent >= OTP_SENDS_PER_HOUR) throw new HttpError(429, '認証番号の送信が上限（1時間に5回）に達しました。1時間ほど待ってから、もう一度お試しください');
    const code = newOtpCode();
    db.prepare('INSERT INTO otp_codes (phone, code_hash, expires_at, attempts) VALUES (?,?,?,0) ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0')
      .run(phone, sha256(phone + ':' + code), now + OTP_TTL);
    db.prepare('INSERT INTO otp_sends (phone, at) VALUES (?, ?)').run(phone, now);
    // 送信の失敗による自動の再送（IF-EXT-003）は、上の回数に数えない（1回の送信として記録済み）
    let delivered;
    if (phone.startsWith('email:')) delivered = await notifier.email(phone.slice(6), 'otp', subjectOf('ログインの認証番号'), compose(setting, { lines: [
      `認証番号は ${code} です。`,
      '5分以内に、ログインの画面に入力してください。',
      '',
      'この番号は、ほかの人に教えないでください。',
      'ログインをしようとしていない場合は、このメールを破棄してください。',
    ] }));
    else delivered = await notifier.sms(phone, 'otp', `【令和の競り】認証番号は ${code} です。5分以内に入力してください。ほかの人に教えないでください。`);
    // 送れなかったのに「送りました」と出さない（再送しても失敗したとき。主催者管理者にも、知らせが残る）
    if (!delivered) throw new HttpError(502, '認証番号を送れませんでした。少し待ってから、やり直してください。続くときは、主催者へご連絡ください');
    return code;
  }
  function checkOtp(phone, code) {
    const row = db.prepare('SELECT * FROM otp_codes WHERE phone = ?').get(phone);
    const fail = new HttpError(400, '認証番号が正しくないか、期限が切れています。番号を送り直してください', { resend: true });
    if (!row || nowMs() > row.expires_at || row.attempts >= OTP_MAX_ATTEMPTS) throw fail;
    if (!safeEqual(row.code_hash, sha256(phone + ':' + String(code ?? '').trim()))) {
      db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ?').run(phone);
      const left = OTP_MAX_ATTEMPTS - (row.attempts + 1);
      throw left > 0 ? new HttpError(400, `認証番号が違います（あと ${left} 回）`) : fail;
    }
    db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(phone); // 1度使った番号は、もう使えない
  }
  const phoneOf = (body) => {
    const phone = normalizePhone(body.phone);
    if (!phone) throw bad('電話番号を、国内の番号（例: 090-1234-5678）で入力してください');
    return phone;
  };

  // ログイン ID とパスワード（発注者の指示。会員が自分で決める）
  // 全角で打った英数字（スマートフォンの日本語入力のまま）も、半角として受ける
  const normLoginId = (v) => String(v ?? '').normalize('NFKC').trim().toLowerCase();
  // 発行するパスワード: 見まちがえやすい字（0 と O、1 と l と I）と記号を使わない、12文字（約59ビット）
  const PASSWORD_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
  const newPassword = () => Array.from({ length: 12 }, () => PASSWORD_CHARS[crypto.randomInt(PASSWORD_CHARS.length)]).join('');
  // 写し取るときに前後に入った空白（改行・全角の空白を含む）は、無いものとして確かめ直す
  const passwordMatches = (input, hash) => {
    const raw = String(input ?? '');
    if (verifyPassword(raw, hash)) return true;
    const trimmed = raw.trim();
    return trimmed !== raw && verifyPassword(trimmed, hash);
  };
  function credentialErrors(body, errors, { memberId = null, need = false } = {}) {
    const loginId = normLoginId(body.loginId), password = String(body.password ?? '');
    if (!need && !loginId && !password) return null;
    if (!/^[a-z0-9._-]{4,32}$/.test(loginId)) errors.loginId = 'ログイン ID は、半角の英数字と . _ - で、4〜32文字にしてください';
    else if (db.prepare('SELECT 1 FROM member_accounts WHERE login_id = ? AND id IS NOT ?').get(loginId, memberId)) errors.loginId = 'このログイン ID は、使われています。別の ID にしてください';
    if (password.length < 8) errors.password = 'パスワードは、8文字以上にしてください';
    else if (password.length > 200) errors.password = 'パスワードが長すぎます';
    else if (password.toLowerCase() === loginId) errors.password = 'ログイン ID と同じパスワードは、使えません';
    return { loginId, password };
  }
  // 登録の宛先: 携帯電話の番号か、メールアドレス
  const registerKey = (body) => {
    const raw = String(body.id ?? body.phone ?? '').trim();
    if (raw.includes('@')) {
      if (!isEmail(raw)) throw bad('メールアドレスを正しく入力してください');
      return 'email:' + raw.toLowerCase();
    }
    if (!config.sms) throw bad('メールアドレスを入力してください');
    const phone = normalizePhone(raw);
    if (!phone) throw bad('携帯電話の番号（例: 090-1234-5678）か、メールアドレスを入力してください');
    return phone;
  };
  // ログインの宛先: 携帯電話の番号か、確認済みのメールアドレス（発注者の指示。メールは、確認が済んだアドレスだけ）
  const loginTarget = (body) => {
    const raw = String(body.id ?? body.phone ?? '').trim();
    if (raw.includes('@')) {
      const email = raw.toLowerCase();
      if (!isEmail(email)) throw bad('メールアドレスを正しく入力してください');
      // 同じアドレスの会員が2人以上いる場合は、だれのことか決められないので、メールではログインさせない
      const rows = db.prepare('SELECT * FROM member_accounts WHERE lower(email) = ? AND email_verified = 1 AND withdrawn_at IS NULL AND approved_at IS NOT NULL').all(email);
      return { key: 'email:' + email, member: rows.length === 1 ? rows[0] : null };
    }
    if (!config.sms) throw bad('メールアドレスを入力してください');
    const phone = normalizePhone(raw);
    if (!phone) throw bad('携帯電話の番号（例: 090-1234-5678）か、メールアドレスを入力してください');
    // メールで登録した人の電話番号は、本人のものと確かめていないので、SMS でのログインには使わせない
    return { key: phone, member: db.prepare('SELECT * FROM member_accounts WHERE phone = ? AND phone_verified = 1 AND approved_at IS NOT NULL').get(phone) ?? null };
  };
  // 氏名・フリガナ・住所を、入力から組み立てて確かめる（会員登録と、登録内容の変更で使う）。
  // 姓名・郵便番号を分けた形（画面の入力）と、1つにまとめた形（name・address）の両方を受ける。
  function personFrom(body, errors) {
    const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
    const out = { name: text(body.name), nameKana: null, address: text(body.address, 300), postalCode: null, prefecture: null, address1: null, address2: null };
    if (body.lastName !== undefined || body.firstName !== undefined) {
      const last = text(body.lastName, 50), first = text(body.firstName, 50);
      if (!last || !first) errors.lastName = '氏名（姓と名）を入力してください';
      out.name = `${last} ${first}`.trim();
      const lk = toKatakana(text(body.lastKana, 50)), fk = toKatakana(text(body.firstKana, 50));
      if (!lk || !fk) errors.lastKana = 'フリガナ（セイとメイ）を入力してください';
      else if (!/^[ァ-ヶー・\s　]+$/.test(lk + fk)) errors.lastKana = 'フリガナは、カタカナで入力してください';
      out.nameKana = `${lk} ${fk}`.trim();
    } else if (!out.name) errors.name = '氏名を入力してください';
    if (body.postalCode !== undefined || body.prefecture !== undefined || body.address1 !== undefined) {
      const zip = toHalfDigits(body.postalCode).replace(/[^0-9]/g, '');
      if (zip.length !== 7) errors.postalCode = '郵便番号を、7桁の数字で入力してください';
      const pref = text(body.prefecture, 10);
      if (!PREFECTURES.includes(pref)) errors.prefecture = '都道府県を選んでください';
      const a1 = text(body.address1, 150), a2 = text(body.address2, 100);
      if (!a1) errors.address1 = '市区町村と番地を入力してください';
      else if (!/[0-9０-９一二三四五六七八九十]/.test(a1)) errors.address1 = '番地まで入力してください';
      Object.assign(out, { postalCode: zip, prefecture: pref, address1: a1, address2: a2 || null, address: `〒${zip.slice(0, 3)}-${zip.slice(3)} ${pref}${a1}${a2 ? ' ' + a2 : ''}` });
    } else if (!out.address) errors.address = '住所を入力してください';
    return out;
  }

  // ------------------------------------------------------------ 会員
  const memberView = (m) => ({
    kind: m.kind, name: m.name, nameKana: m.name_kana, loginId: m.login_id ?? null, hasPassword: !!m.password_hash, phone: m.phone, phoneVerified: !!m.phone_verified, email: m.email, emailVerified: !!m.email_verified, address: m.address,
    postalCode: m.postal_code, prefecture: m.prefecture, address1: m.address1, address2: m.address2,
    shipTo: m.ship_to, company: m.company, contactName: m.contact_name, billing: m.billing, suspended: !!billing.suspension(m.id), suspendedBy: billing.suspension(m.id), eventMail: m.event_mail !== 0 && m.event_mail_consent_at !== null,
  });
  async function sendEmailVerification(ctx, member) {
    const token = randomToken();
    // 確認のリンクは、送った先のアドレスにだけ効く（あとでアドレスを変えた人が、古いリンクで、別のアドレスを確認済みにできないように）
    db.prepare('DELETE FROM email_tokens WHERE member_id = ?').run(member.id);
    db.prepare('INSERT INTO email_tokens (token_hash, member_id, expires_at, email) VALUES (?,?,?,?)').run(sha256(token), member.id, nowMs() + DAY, String(member.email).toLowerCase());
    const origin = `${ctx.req.headers['x-forwarded-proto'] ?? 'http'}://${(config.trustProxy && ctx.req.headers['x-forwarded-host']) || ctx.req.headers.host}`;
    await notifier.email(member.email, 'verify_email', subjectOf('メールアドレスの確認'), compose(setting, { name: nameOf(member), lines: [
      'このメールアドレスを、令和の競りの会員のアドレスとして登録しました。',
      '次のリンクを開くと、確認が終わります（このメールから24時間、有効です）。',
      '',
      `${origin}/api/email/verify?token=${token}`,
      '',
      'お心当たりがない場合は、リンクを開かずに、このメールを破棄してください。',
    ] }));
    return `${origin}/api/email/verify?token=${token}`;
  }

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:id/g, '(\\d+)') + '$'), handler });

  // 請求・消し込み・手数料（MVP の 6）
  const billing = createBilling({ db, config, nowMs, audit, notifier, setting, route, needStaff, needMember, HttpError, bad });

  route('GET', '/api/me', (ctx) => ({
    member: ctx.member ? memberView(ctx.member) : null,
    staff: ctx.staff ? { loginId: ctx.staff.login_id, name: ctx.staff.name, role: ctx.staff.role, roleLabel: ROLE_LABEL[ctx.staff.role] } : null,
    registering: !!ctx.registerPhone,
    // 登録の途中の人: どちらで確かめたか（メールなら、そのアドレス）
    ...(ctx.registerPhone ? { registerVia: ctx.registerPhone.startsWith('email:') ? 'email' : 'sms', registerId: ctx.registerPhone.replace(/^email:/, '') } : {}),
    // 外の保存先への保存が、30秒より長く失敗し続けているか（スタッフにだけ知らせる。画面に警告を出す）
    ...(ctx.staff ? { storageFailing: (() => { const st = persistStatus(); return !!(st && st.failingSince && nowMs() - st.failingSince > 30000); })() } : {}),
  }));

  // 登録: 電話番号 → SMS 認証 → 入力
  // 登録を始める認証番号は、だれにでも送れてしまうので、数を絞る（架空の宛先で送り続けて、認証メールを止めたり、他人に迷惑メールを送らせたりするのを防ぐ）。
  // 同じ接続元から 10分に20通まで（会場の Wi-Fi で、何人かが続けて登録できる数）。全体で 1分に30通まで
  const registerSends = { byIp: new Map(), all: [] };
  function limitRegister(ctx) {
    if (!(config.authRatePerMin > 0)) return;
    const now = nowMs();
    const mine = (registerSends.byIp.get(ctx.ip) ?? []).filter((t) => now - t < 10 * MIN);
    registerSends.all = registerSends.all.filter((t) => now - t < MIN);
    if (mine.length >= 20 || registerSends.all.length >= 30) throw new HttpError(429, 'ただいま、登録が混み合っています。数分待ってから、やり直してください');
    mine.push(now); registerSends.all.push(now);
    if (registerSends.byIp.size > 5000) for (const [k, v] of registerSends.byIp) if (!v.some((t) => now - t < 10 * MIN)) registerSends.byIp.delete(k);
    registerSends.byIp.set(ctx.ip, mine);
  }
  route('POST', '/api/register/start', async (ctx, body) => {
    throttle(ctx);
    const phone = registerKey(body);
    if (phone.startsWith('email:')) {
      // メールアドレスで登録を始める（発注者の指示）。確認済みの会員がいるアドレスは、ログインへ案内する
      if (db.prepare('SELECT 1 FROM member_accounts WHERE lower(email) = ? AND email_verified = 1 AND withdrawn_at IS NULL').get(phone.slice(6))) throw new HttpError(409, 'このメールアドレスは登録済みです。ログインしてください', { login: true });
    } else {
      // スタッフとして登録された番号では、会員登録できない（FR-AUTH-013）
      if (db.prepare('SELECT 1 FROM staff_accounts WHERE phone = ?').get(phone)) throw new HttpError(409, 'この電話番号では登録できません');
      // 確かめ済みの番号の会員がいれば、ログインへ。メールで登録した人の（確かめていない）番号とは、重なってもよい
      if (db.prepare('SELECT 1 FROM member_accounts WHERE phone = ? AND phone_verified = 1').get(phone)) throw new HttpError(409, 'この電話番号は登録済みです。ログインしてください', { login: true });
    }
    limitRegister(ctx);
    const code = await sendOtp(phone);
    // お試し用の設定のときだけ、認証番号を画面に出せるように返す（本番では返さない）
    return { ok: true, via: phone.startsWith('email:') ? 'email' : 'sms', ...(config.devShowCodes ? { devCode: code } : {}) };
  });
  route('POST', '/api/register/verify', (ctx, body) => {
    throttle(ctx);
    const phone = registerKey(body);
    checkOtp(phone, body.code);
    startSession(ctx, 'register', null, REGISTER_LIFETIME, phone);
    return { ok: true, via: phone.startsWith('email:') ? 'email' : 'sms' };
  });
  route('POST', '/api/register/complete', async (ctx, body) => {
    const verified = ctx.registerPhone; // 認証番号で確かめた宛先（電話番号か「email:アドレス」）
    if (!verified) throw new HttpError(401, '先に、電話番号かメールアドレスの確認を済ませてください');
    const byEmail = verified.startsWith('email:');
    const phone = byEmail ? normalizePhone(body.phone) : verified;
    const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
    const kind = body.kind === 'b2b' ? 'b2b' : body.kind === 'b2c' ? 'b2c' : null;
    const errors = {};
    if (!kind) errors.kind = '法人か個人かを選んでください';
    const person = personFrom(body, errors);
    const { name, address } = person;
    const email = byEmail ? verified.slice(6) : text(body.email, 254);
    if (!isEmail(email)) errors.email = 'メールアドレスを正しく入力してください';
    // メールで登録する人は、電話番号をここで入れる（本人のものかは、まだ確かめない）
    if (byEmail && !phone) errors.phone = '電話番号を、国内の番号（例: 090-1234-5678）で入力してください';
    else if (byEmail && (db.prepare('SELECT 1 FROM member_accounts WHERE phone = ? AND phone_verified = 1').get(phone) || db.prepare('SELECT 1 FROM staff_accounts WHERE phone = ?').get(phone))) errors.phone = 'この電話番号では登録できません。会場の受付にお申し出ください';
    const company = text(body.company), contactName = text(body.contactName), billing = text(body.billing, 300);
    if (kind === 'b2b') {
      if (!company) errors.company = '会社名を入力してください';
      if (!contactName) errors.contactName = '担当者名を入力してください';
      if (!billing) errors.billing = '請求先を入力してください';
    }
    // 個人は、18歳以上であることの申告が必須（FR-AUTH-003）
    if (kind === 'b2c' && body.adult !== true) errors.adult = '18歳以上であることを確認してください';
    // 利用規約が登録されていれば、同意が必須（文面は、主催者設定で入れる）
    // 規約への同意は、いつも必須（発注者の決定。報告書 80 章）
    if (body.agreed !== true) errors.agreed = '利用規約とプライバシーポリシーをお読みのうえ、同意してください';
    if (Object.keys(errors).length) throw bad('入力を確かめてください', { errors });
    if (db.prepare('SELECT 1 FROM member_accounts WHERE phone = ? AND phone_verified = 1').get(phone) || db.prepare('SELECT 1 FROM staff_accounts WHERE phone = ?').get(phone)) {
      throw new HttpError(409, 'この電話番号では登録できません');
    }
    const now = nowMs();
    const info = db.prepare(`INSERT INTO member_accounts (kind, name, phone, email, address, ship_to, company, contact_name, billing, adult_declared, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(kind, name, phone, email, address, text(body.shipTo, 300) || null,
      kind === 'b2b' ? company : null, kind === 'b2b' ? contactName : null, kind === 'b2b' ? billing : null, kind === 'b2c' ? 1 : 0, now, now);
    if (body.agreed === true) db.prepare('UPDATE member_accounts SET agreed_at = ? WHERE id = ?').run(now, info.lastInsertRowid);
    // 開催のお知らせメール: 登録の画面のチェック（最初は外してある）で、受け取ると選んだ人にだけ送る。同意の時刻と場所を残す（特定電子メール法）
    if (body.eventMail === true) db.prepare("UPDATE member_accounts SET event_mail = 1, event_mail_consent_at = ?, event_mail_consent_via = 'register' WHERE id = ?").run(now, info.lastInsertRowid);
    else db.prepare('UPDATE member_accounts SET event_mail = 0 WHERE id = ?').run(info.lastInsertRowid);
    db.prepare('UPDATE member_accounts SET name_kana = ?, postal_code = ?, prefecture = ?, address1 = ?, address2 = ? WHERE id = ?')
      .run(person.nameKana, person.postalCode, person.prefecture, person.address1, person.address2, info.lastInsertRowid);
    if (byEmail) db.prepare('UPDATE member_accounts SET email_verified = 1, phone_verified = 0 WHERE id = ?').run(info.lastInsertRowid);

    if (config.autoApprove) db.prepare('UPDATE member_accounts SET approved_at = ? WHERE id = ?').run(now, info.lastInsertRowid);
    const member = db.prepare('SELECT * FROM member_accounts WHERE id = ?').get(info.lastInsertRowid);
    endSession(ctx);
    audit({ ...ctx, member }, 'member.register', { target: `member:${member.id}`, after: { kind } });
    if (!member.approved_at) {
      // 承認待ち: ログインはさせない。主催者管理者が承認すると、ログイン ID とパスワードを、承認のメールで送る
      if (!byEmail) await sendEmailVerification(ctx, member);
      return { ok: true, pending: true };
    }
    startSession(ctx, 'member', member.id, MEMBER_IDLE);
    // メールで登録した人は、アドレスの確認が済んでいるので、確認のメールは送らない
    const verifyUrl = byEmail ? null : await sendEmailVerification(ctx, member); // 確認が済んでいなくても入札はできる（FR-AUTH-011）
    return { ok: true, member: memberView(member), ...(config.devShowCodes ? { devVerifyUrl: verifyUrl } : {}) };
  });

  // 登録内容の変更（本人）。電話番号は、ここでは変えられない（主催者管理者の本人確認が要る。FR-AUTH-006）
  route('POST', '/api/my/profile', async (ctx, body) => {
    const m = needMember(ctx);
    const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
    const errors = {};
    const person = personFrom(body, errors);
    const next = { name: person.name, email: text(body.email, 254), address: person.address, ship_to: text(body.shipTo, 300) || null,
      company: m.kind === 'b2b' ? text(body.company) : null, contact_name: m.kind === 'b2b' ? text(body.contactName) : null, billing: m.kind === 'b2b' ? text(body.billing, 300) : null };
    if (!isEmail(next.email)) errors.email = 'メールアドレスを正しく入力してください';
    if (m.kind === 'b2b') { if (!next.company) errors.company = '会社名を入力してください'; if (!next.contact_name) errors.contactName = '担当者名を入力してください'; if (!next.billing) errors.billing = '請求先を入力してください'; }
    if (Object.keys(errors).length) throw bad('入力を確かめてください', { errors });
    const emailChanged = next.email !== m.email;
    db.prepare('UPDATE member_accounts SET name=?, email=?, email_verified=?, address=?, ship_to=?, company=?, contact_name=?, billing=?, updated_at=? WHERE id=?')
      .run(next.name, next.email, emailChanged ? 0 : m.email_verified, next.address, next.ship_to, next.company, next.contact_name, next.billing, nowMs(), m.id);
    // 分けて入れた場合だけ、フリガナと住所の内訳を書き換える（まとめた形で届いたときは、前の内訳を消す）
    db.prepare('UPDATE member_accounts SET name_kana = ?, postal_code = ?, prefecture = ?, address1 = ?, address2 = ? WHERE id = ?')
      .run(person.nameKana ?? (body.lastName === undefined ? m.name_kana : null), person.postalCode, person.prefecture, person.address1, person.address2, m.id);
    audit(ctx, 'member.update', { target: `member:${m.id}`, after: { fields: Object.keys(next).filter((k) => next[k] !== m[k]) } });
    const fresh = db.prepare('SELECT * FROM member_accounts WHERE id = ?').get(m.id);
    if (emailChanged) await sendEmailVerification(ctx, fresh); // 新しいアドレスを、確認メールで確かめ直す
    return { ok: true, member: memberView(fresh) };
  });
  // 開催のお知らせメールを受け取るか（本人が切り替える）
  route('POST', '/api/my/event-mail', (ctx, body) => {
    const m = needMember(ctx);
    const on = body.on === true;
    db.prepare('UPDATE member_accounts SET event_mail = ?, updated_at = ? WHERE id = ?').run(on ? 1 : 0, nowMs(), m.id);
    // 受け取ると切り替えたときは、同意の時刻と場所を残す（特定電子メール法）
    if (on) db.prepare("UPDATE member_accounts SET event_mail_consent_at = ?, event_mail_consent_via = 'mypage' WHERE id = ?").run(nowMs(), m.id);
    audit(ctx, 'member.event_mail', { target: `member:${m.id}`, after: { on } });
    return { ok: true, eventMail: on };
  });
  // 開催のお知らせメールの配信を、ログインせずに止める（メールに載せたリンクから。特定電子メール法の受信拒否。報告書 96 章）
  route('POST', '/api/unsubscribe', (ctx, body) => {
    const t = String(body?.t ?? '');
    const m = t.length >= 20 ? db.prepare('SELECT * FROM member_accounts WHERE unsub_token = ?').get(t) : null;
    if (!m) throw new HttpError(404, 'このリンクは使えません。マイページの「個人情報の設定」から止めてください');
    if (m.event_mail) {
      db.prepare('UPDATE member_accounts SET event_mail = 0, updated_at = ? WHERE id = ?').run(nowMs(), m.id);
      audit({ system: true }, 'member.event_mail', { target: `member:${m.id}`, after: { on: false, via: 'unsubscribe_link' } });
    }
    return { ok: true };
  });
  // 退会（FR-AUTH-014）。お支払いが済んでいない明細があるあいだは、退会できない。請求・取引・監査の記録は残す
  route('POST', '/api/my/withdraw', (ctx) => {
    const m = needMember(ctx);
    const open = db.prepare('SELECT COUNT(*) AS n FROM bill_lines WHERE account_id = ? AND cleared_at IS NULL AND cancelled_at IS NULL').get(m.id).n;
    if (open) throw new HttpError(409, 'お支払いが済んでいない落札があるため、退会できません。お支払いのあとに、もう一度お手続きください');
    // 競りの最中の品で最高入札者のあいだ、繰り上げの打診に答えていないあいだは、退会できない（退会した人に落札・請求が付かないように。本番運用の評価 B5）
    const leading = db.prepare(`SELECT l.lot_no FROM lots l JOIN bids b ON b.seq = l.current_bid_seq JOIN members p ON p.id = b.member_id
      WHERE p.account_id = ? AND l.status IN ('preparing','preparing_warn','open','suspended') LIMIT 1`).get(m.id);
    if (leading) throw new HttpError(409, `いま競りの最中の品（No.${leading.lot_no}）で、最高入札者になっています。競りが終わってから、もう一度お手続きください`);
    if (db.prepare("SELECT 1 FROM offers WHERE account_id = ? AND state = 'open'").get(m.id)) throw new HttpError(409, '繰り上げ落札のご案内に、まだお答えいただいていません。お答えのあとに、もう一度お手続きください');
    db.transaction(() => {
      // 電話番号を空けて、同じ番号でもう一度登録できるようにする。元の番号は、記録として残す
      db.prepare('UPDATE member_accounts SET withdrawn_at = ?, withdrawn_phone = phone, phone = ?, updated_at = ? WHERE id = ?').run(nowMs(), `退会:${m.id}`, nowMs(), m.id);
      dropLogin(m.id);
    })();
    audit(ctx, 'member.withdraw', { target: `member:${m.id}` });
    ctx.res.setHeader('set-cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return { ok: true };
  });
  // 電話番号の変更（主催者管理者が、本人を確かめたうえで行う。FR-AUTH-006）
  route('POST', '/api/members/:id/phone', (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const m = db.prepare('SELECT * FROM member_accounts WHERE id = ? AND withdrawn_at IS NULL').get(id);
    if (!m) throw new HttpError(404, '会員が見つかりません');
    const phone = phoneOf(body), reason = String(body.reason ?? '').trim().slice(0, 500);
    if (!reason) throw bad('本人を確かめた方法を、入力してください');
    if (db.prepare('SELECT 1 FROM member_accounts WHERE phone = ? AND phone_verified = 1 AND id <> ?').get(phone, id) || db.prepare('SELECT 1 FROM staff_accounts WHERE phone = ?').get(phone)) throw new HttpError(409, 'この電話番号は、すでに（本人のものと確かめた番号として）使われています');
    db.prepare('UPDATE member_accounts SET phone = ?, phone_verified = 1, updated_at = ? WHERE id = ?').run(phone, nowMs(), id); // 受付で本人を確かめた番号
    db.prepare("DELETE FROM sessions WHERE kind = 'member' AND subject_id = ?").run(id); // 古い番号でのログインを切る
    audit(ctx, 'member.phone_change', { target: `member:${id}`, reason });
    return { ok: true };
  });

  // ログイン: 電話番号と SMS の認証番号。パスワードは使わない（FR-AUTH-010）
  route('POST', '/api/login/start', async (ctx, body) => {
    throttle(ctx);
    const target = loginTarget(body);
    // 登録のない宛先でも、同じ返事をする（どの番号・アドレスが登録済みかを、外から調べられないようにする）
    const code = target.member ? await sendOtp(target.key) : null;
    // ログインの認証番号は、お試し用の設定でも返事に入れない（入れると、他人の宛先を知っているだけで、その会員になりすませる。本番運用の評価 A1。報告書 102 章）
    void code;
    return { ok: true, via: target.key.startsWith('email:') ? 'email' : 'sms' };
  });
  // ログイン ID とパスワードでのログイン（発注者の指示）。どちらが違ったかは、伝えない
  route('POST', '/api/login/password', (ctx, body) => {
    throttle(ctx);
    const fail = new HttpError(401, 'ログイン ID かパスワードが違います');
    const m = db.prepare('SELECT * FROM member_accounts WHERE login_id = ? AND withdrawn_at IS NULL AND approved_at IS NOT NULL').get(normLoginId(body.loginId));
    if (!m || !m.password_hash) throw fail;
    const now = nowMs();
    const trusted = trustedDevice(ctx, 'm', m.id); // いつもの端末には、ロックを掛けない
    if (m.login_locked_until > now && !trusted) throw new HttpError(423, `誤りが続いたため、しばらくログインできません。${Math.ceil((m.login_locked_until - now) / MIN)} 分後にやり直すか、「パスワードを忘れた方」からお入りください`);
    if (!passwordMatches(body.password, m.password_hash)) {
      if (trusted) throw fail;
      const failed = m.login_failed + 1;
      db.prepare('UPDATE member_accounts SET login_failed = ?, login_locked_until = ? WHERE id = ?').run(failed >= LOGIN_FAIL_MAX ? 0 : failed, failed >= LOGIN_FAIL_MAX ? now + LOGIN_LOCK : 0, m.id);
      throw fail;
    }
    db.prepare('UPDATE member_accounts SET login_failed = 0, login_locked_until = 0 WHERE id = ?').run(m.id);
    startSession(ctx, 'member', m.id, MEMBER_IDLE);
    trustDevice(ctx, 'm', m.id);
    audit({ ...ctx, member: m }, 'member.login', { target: `member:${m.id}`, after: { via: 'password' } });
    return { ok: true, member: memberView(m) };
  });
  // ログイン ID とパスワードを決める・変える。いまのパスワードが要る（まだ無い人と、認証番号でログインした直後の人は、要らない）
  route('POST', '/api/my/credentials', (ctx, body) => {
    const m = needMember(ctx);
    throttle(ctx);
    const errors = {};
    if (m.password_hash && !ctx.viaOtp && !verifyPassword(String(body.currentPassword ?? ''), m.password_hash)) errors.currentPassword = 'いまのパスワードが違います';
    const cred = credentialErrors(body, errors, { memberId: m.id, need: true });
    if (Object.keys(errors).length) throw bad('入力を確かめてください', { errors });
    db.prepare('UPDATE member_accounts SET login_id = ?, password_hash = ?, login_failed = 0, login_locked_until = 0, updated_at = ? WHERE id = ?').run(cred.loginId, hashPassword(cred.password), nowMs(), m.id);
    // ほかの端末のログインは切る（パスワードを変えたのに、古い端末が入ったままにならないように）
    db.prepare("DELETE FROM sessions WHERE kind = 'member' AND subject_id = ? AND id_hash <> ?").run(m.id, ctx.sessionHash);
    audit(ctx, 'member.credentials', { target: `member:${m.id}` });
    return { ok: true, member: memberView(db.prepare('SELECT * FROM member_accounts WHERE id = ?').get(m.id)) };
  });
  route('POST', '/api/login/verify', (ctx, body) => {
    throttle(ctx);
    const target = loginTarget(body);
    checkOtp(target.key, body.code);
    const member = target.member;
    if (!member) throw new HttpError(400, '認証番号が正しくないか、期限が切れています。番号を送り直してください', { resend: true });
    startSession(ctx, 'member', member.id, MEMBER_IDLE, 'otp');
    trustDevice(ctx, 'm', member.id);
    audit({ ...ctx, member }, 'member.login', { target: `member:${member.id}`, after: { via: 'code' } });
    return { ok: true, member: memberView(member) };
  });
  route('POST', '/api/logout', (ctx) => { endSession(ctx); return { ok: true }; });
  route('POST', '/api/email/resend', async (ctx) => {
    const member = needMember(ctx);
    if (member.email_verified) return { ok: true };
    throttle(ctx);
    const verifyUrl = await sendEmailVerification(ctx, member);
    return { ok: true, ...(config.devShowCodes ? { devVerifyUrl: verifyUrl } : {}) };
  });
  // 郵便番号から住所を引く（会員登録の入力の手間を減らす）
  route('GET', '/api/postal', (ctx) => {
    throttle(ctx, 'postal', 60);
    const code = toHalfDigits(ctx.url.searchParams.get('code')).replace(/[^0-9]/g, '');
    if (code.length !== 7) throw bad('郵便番号を、7桁の数字で入力してください');
    return { ok: true, results: lookupPostal(code).slice(0, 20) };
  });
  route('GET', '/api/email/verify', (ctx) => {
    const token = ctx.url.searchParams.get('token') ?? '';
    const row = db.prepare('SELECT * FROM email_tokens WHERE token_hash = ?').get(sha256(token));
    const owner = row ? db.prepare('SELECT email FROM member_accounts WHERE id = ?').get(row.member_id) : null;
    const ok = !!row && nowMs() <= row.expires_at && !!row.email && String(owner?.email ?? '').toLowerCase() === row.email;
    if (ok) {
      db.prepare('UPDATE member_accounts SET email_verified = 1, updated_at = ? WHERE id = ?').run(nowMs(), row.member_id);
      db.prepare('DELETE FROM email_tokens WHERE member_id = ?').run(row.member_id);
    }
    return { redirect: `/mypage.html?email=${ok ? 'verified' : 'expired'}` };
  });

  // ------------------------------------------------------------ スタッフ
  // スタッフのログイン: メールアドレスとパスワード（発注者の指示。認証アプリのコードは、使わなくなった）。
  // メールアドレスを登録していない、前からのアカウントは、ログイン ID でも入れる
  const staffByLogin = (raw) => {
    const id = String(raw ?? '').trim().toLowerCase();
    return (id.includes('@') ? db.prepare('SELECT * FROM staff_accounts WHERE lower(email) = ?').get(id) : db.prepare('SELECT * FROM staff_accounts WHERE login_id = ?').get(id)) ?? null;
  };
  const staffFailed = (ctx, staff, now) => {
    const failed = staff.failed_count + 1;
    const lock = failed >= LOCK_AFTER;
    db.prepare('UPDATE staff_accounts SET failed_count = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : failed, lock ? now + LOCK_FOR : 0, staff.id);
    if (lock) audit({ ...ctx, system: true }, 'staff.locked', { target: `staff:${staff.id}` });
  };
  const staffOut = (staff) => ({ loginId: staff.login_id, email: staff.email ?? null, name: staff.name, role: staff.role, roleLabel: ROLE_LABEL[staff.role] });
  route('POST', '/api/staff/login', (ctx, body) => {
    throttle(ctx);
    const staff = staffByLogin(body.email ?? body.loginId);
    // どれが違ったか（登録の有無・パスワードが未登録か）は、伝えない
    const fail = new HttpError(401, 'メールアドレスかパスワードが違います。はじめてログインする方は、下の「はじめての方」からお進みください');
    if (!staff || !staff.active) throw fail;
    const now = nowMs();
    const trusted = trustedDevice(ctx, 's', staff.id); // いつもの端末には、ロックを掛けない（締め出しを防ぐ）
    if (staff.locked_until > now && !trusted) throw new HttpError(423, `誤りが続いたため、ロックしています。${Math.ceil((staff.locked_until - now) / MIN)} 分後にやり直してください`);
    if (!staff.password_hash || !verifyPassword(body.password ?? '', staff.password_hash)) {
      if (staff.password_hash && !trusted) staffFailed(ctx, staff, now);
      throw fail;
    }
    db.prepare('UPDATE staff_accounts SET failed_count = 0, locked_until = 0 WHERE id = ?').run(staff.id);
    startSession(ctx, 'staff', staff.id, STAFF_LIFETIME);
    trustDevice(ctx, 's', staff.id);
    audit({ ...ctx, staff }, 'staff.login', { target: `staff:${staff.id}` });
    return { ok: true, staff: staffOut(staff) };
  });
  // パスワードを決められるのは、招待（またはリセット）のメールに入っているリンクを開いた人だけ。
  // リンクには、1回だけ使える合言葉が入っている（データベースには、ハッシュだけを持つ）。メールを受け取れる人＝本人、と確かめる。
  // （前は、メールアドレスを知っているだけで決められた。公開している設定のハッシュから、最初の主催者管理者を先取りできた）
  const pendingByToken = (token) => {
    const t = String(token ?? '');
    if (t.length < 20 || t.length > 200) return null;
    const staff = db.prepare('SELECT * FROM staff_accounts WHERE setup_hash = ?').get(sha256('setup:' + t));
    return staff && staff.active && staff.email && !staff.password_hash && nowMs() <= staff.setup_expires ? staff : null;
  };
  const setupFail = () => new HttpError(401, 'このリンクでは、パスワードを決められません。すでに決めてあるか、期限（7日）が過ぎています。主催者管理者に、メールの送り直しを頼んでください');
  // リンクを開いたときに、だれのパスワードを決めるのかを出す
  route('POST', '/api/staff/setup/check', (ctx, body) => {
    throttle(ctx);
    const staff = pendingByToken(body.token);
    if (!staff) throw setupFail();
    return { ok: true, email: staff.email, roleLabel: ROLE_LABEL[staff.role] };
  });
  route('POST', '/api/staff/setup', (ctx, body) => {
    throttle(ctx);
    const staff = pendingByToken(body.token);
    if (!staff) throw setupFail();
    const password = String(body.password ?? '');
    if (password.length < 12 || password.length > 200) throw bad('入力を確かめてください', { errors: { password: 'パスワードは、12文字以上にしてください' } });
    // パスワードは、元に戻せない形（scrypt のハッシュ）で保存する。合言葉は、ここで使えなくなる
    db.prepare('UPDATE staff_accounts SET password_hash = ?, setup_hash = NULL, setup_expires = 0, failed_count = 0, locked_until = 0 WHERE id = ?').run(hashPassword(password), staff.id);
    startSession(ctx, 'staff', staff.id, STAFF_LIFETIME);
    audit({ ...ctx, staff }, 'staff.setup', { target: `staff:${staff.id}` });
    return { ok: true, staff: staffOut(staff) };
  });
  // 「はじめての方」: メールアドレスを入れると、パスワードを決めるためのメールを送る。
  // 送るのは、(1) 招待されていて、まだパスワードを決めていないスタッフ、(2) 設定にあるメールアドレス（ハッシュで照らす）の、最初の主催者管理者。
  // 返事は、どの場合も同じ（登録があるかどうかを、教えない）。同じ宛先には、10分に1通まで
  const setupMailAt = new Map();
  route('POST', '/api/staff/setup/request', async (ctx, body) => {
    throttle(ctx);
    const mail = String(body.email ?? '').trim().toLowerCase();
    const same = { ok: true };
    if (!isEmail(mail)) return same;
    const last = setupMailAt.get(mail) ?? 0;
    if (nowMs() - last < 10 * MIN) return same;
    let staff = staffByLogin(mail);
    // メールアドレスの主催者管理者が1人でもできたら、最初の主催者管理者の道は閉じる（2人目からは、主催者管理者が登録する）
    const hasEmailAdmin = () => !!db.prepare("SELECT 1 FROM staff_accounts WHERE role = 'admin' AND email IS NOT NULL").get();
    if (!staff && config.adminEmailHash && safeEqual(sha256(mail), config.adminEmailHash) && !hasEmailAdmin()) {
      const made = inviteStaff({ email: mail, name: '管理者', role: 'admin' });
      audit({ ...ctx, system: true }, 'staff.create', { target: `staff:${made.id}`, after: { role: 'admin', by: '最初の主催者管理者' } });
      staff = staffByLogin(mail);
    }
    if (!staff || !staff.active || !staff.email || staff.password_hash) return same;
    if (setupMailAt.size > 5000) setupMailAt.clear();
    setupMailAt.set(mail, nowMs());
    await sendStaffInvite(ctx, { id: staff.id, email: staff.email, role: staff.role, name: staff.name });
    return same;
  });
  // パスワードの変更（最初に渡された仮のパスワードを、本人が変える）
  route('POST', '/api/staff/password', (ctx, body) => {
    const me = ctx.staff;
    if (!me) throw new HttpError(401, 'スタッフのログインが必要です');
    throttle(ctx);
    if (!verifyPassword(body.current ?? '', me.password_hash)) throw bad('いまのパスワードが違います');
    const next = String(body.next ?? '');
    if (next.length < 12 || next.length > 200) throw bad('新しいパスワードは、12文字以上にしてください');
    db.prepare('UPDATE staff_accounts SET password_hash = ? WHERE id = ?').run(hashPassword(next), me.id);
    // ほかの端末のログインは切る（この端末だけを残す）
    db.prepare("DELETE FROM sessions WHERE kind = 'staff' AND subject_id = ? AND id_hash <> ?").run(me.id, ctx.sessionHash);
    audit(ctx, 'staff.password_change', { target: `staff:${me.id}` });
    return { ok: true };
  });
  const staffView = (s) => ({ id: s.id, loginId: s.login_id, email: s.email ?? null, ready: !!s.password_hash, name: s.name, role: s.role, roleLabel: ROLE_LABEL[s.role], phone: s.phone, active: !!s.active });
  route('GET', '/api/staff/accounts', (ctx) => {
    needStaff(ctx, 'admin');
    return { staff: db.prepare('SELECT * FROM staff_accounts ORDER BY id').all().map(staffView) };
  });
  route('POST', '/api/staff/accounts', async (ctx, body) => {
    needStaff(ctx, 'admin');
    // 前からの形（ログイン ID と、仮のパスワード）。画面からは使わない。自動テストと、道具（tools/）のために残してある
    if (!body.email && body.loginId) {
      const made = createStaff({ loginId: body.loginId, name: body.name, role: body.role, phone: body.phone });
      audit(ctx, 'staff.create', { target: `staff:${made.id}`, after: { loginId: made.loginId, role: made.role } });
      return { ok: true, ...made, qrSvg: await QRCode.toString(made.otpauthUrl, { type: 'svg', margin: 2 }) };
    }
    // 主催者管理者が、新しいスタッフのメールアドレスを登録する（発注者の指示）。パスワードは、本人が最初のログインで決める
    const created = inviteStaff({ email: body.email, name: body.name, role: body.role, phone: body.phone });
    audit(ctx, 'staff.create', { target: `staff:${created.id}`, after: { email: created.email, role: created.role } });
    const link = await sendStaffInvite(ctx, { ...created, name: String(body.name ?? '').trim() });
    return { ok: true, ...created, ...link };
  });
  // パスワードと認証アプリの再発行（端末をなくした・忘れたとき）。それまでのログインは、すべて切る
  route('POST', '/api/staff/accounts/:id/reset', async (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const target = db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(id);
    if (!target) throw new HttpError(404, 'スタッフが見つかりません');
    if (target.email) {
      // メールアドレスのスタッフ: パスワードを消す。本人が、もう一度「はじめての方」から決める（7日以内）
      db.prepare("UPDATE staff_accounts SET password_hash = '', setup_hash = NULL, setup_expires = ?, failed_count = 0, locked_until = 0 WHERE id = ?").run(nowMs() + SETUP_LIFETIME, id);
      db.prepare("DELETE FROM sessions WHERE kind = 'staff' AND subject_id = ?").run(id);
      audit(ctx, 'staff.reset', { target: `staff:${id}` });
      const out = { id: Number(id), email: target.email, role: target.role };
      const link = await sendStaffInvite(ctx, { ...out, name: target.name }, { reset: true });
      return { ok: true, ...out, ...link };
    }
    const password = randomToken(12), secret = newTotpSecret();
    db.prepare('UPDATE staff_accounts SET password_hash = ?, totp_secret = ?, failed_count = 0, locked_until = 0 WHERE id = ?').run(hashPassword(password), secret, id);
    db.prepare("DELETE FROM sessions WHERE kind = 'staff' AND subject_id = ? AND id_hash <> ?").run(id, ctx.sessionHash);
    audit(ctx, 'staff.reset', { target: `staff:${id}` });
    const url = otpauthUrl(secret, target.login_id);
    return { ok: true, loginId: target.login_id, initialPassword: password, totpSecret: secret, qrSvg: await QRCode.toString(url, { type: 'svg', margin: 2 }) };
  });
  route('POST', '/api/staff/accounts/:id/stop', (ctx, body, id) => {
    const me = needStaff(ctx, 'admin');
    if (id === me.id) throw bad('自分のアカウントは停止できません');
    const target = db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(id);
    if (!target) throw new HttpError(404, 'スタッフが見つかりません');
    db.prepare('UPDATE staff_accounts SET active = 0 WHERE id = ?').run(id);
    db.prepare("DELETE FROM sessions WHERE kind = 'staff' AND subject_id = ?").run(id);
    audit(ctx, 'staff.stop', { target: `staff:${id}`, before: { active: true }, after: { active: false } });
    return { ok: true };
  });
  // 停止を解く（発注者の指示。報告書 80 章）。パスワードと認証アプリは、停止の前のまま
  route('POST', '/api/staff/accounts/:id/reactivate', (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const target = db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(id);
    if (!target) throw new HttpError(404, 'スタッフが見つかりません');
    if (target.active) throw new HttpError(409, 'このスタッフは、停止されていません');
    db.prepare('UPDATE staff_accounts SET active = 1, failed_count = 0, locked_until = 0 WHERE id = ?').run(id);
    audit(ctx, 'staff.reactivate', { target: `staff:${id}`, before: { active: false }, after: { active: true } });
    return { ok: true };
  });
  /** スタッフを作る。最初の主催者管理者は、tools/create-admin.js から呼ぶ */
  // ---- メールアドレスで登録するスタッフ（パスワードは、本人が最初のログインで決める）
  const SETUP_LIFETIME = 7 * DAY; // 登録してから、パスワードを決められる期限
  function inviteStaff({ email, name, role, phone }) {
    const mail = String(email ?? '').trim().toLowerCase();
    if (!isEmail(mail)) throw bad('メールアドレスを正しく入力してください');
    if (!ROLE_LABEL[role]) throw bad('役割を選んでください');
    const fullName = String(name ?? '').trim().slice(0, 100);
    if (!fullName) throw bad('名前を入力してください');
    const tel = phone ? normalizePhone(phone) : null;
    if (phone && !tel) throw bad('電話番号を、国内の番号で入力してください');
    if (tel && db.prepare('SELECT 1 FROM member_accounts WHERE phone = ? AND phone_verified = 1').get(tel)) throw new HttpError(409, 'この電話番号は、会員として登録されています');
    if (db.prepare('SELECT 1 FROM staff_accounts WHERE lower(email) = ? OR login_id = ?').get(mail, mail)) throw new HttpError(409, 'このメールアドレスは、スタッフとして登録済みです');
    const info = db.prepare("INSERT INTO staff_accounts (login_id, email, name, role, phone, password_hash, totp_secret, created_at) VALUES (?,?,?,?,?,'',?,?)")
      .run(mail, mail, fullName, role, tel, newTotpSecret(), nowMs());
    const id = Number(info.lastInsertRowid);
    db.prepare('UPDATE staff_accounts SET setup_expires = ? WHERE id = ?').run(nowMs() + SETUP_LIFETIME, id);
    return { id, email: mail, role };
  }
  async function sendStaffInvite(ctx, s, { reset = false } = {}) {
    // リンクの先は、設定のサイトの URL。無ければ、主催者管理者が開いているページの URL（入口の Worker が付ける値。利用者は書き換えられない）
    const origin = config.siteUrl || setting('site_url') || `${ctx.req.headers['x-forwarded-proto'] ?? 'http'}://${(config.trustProxy && ctx.req.headers['x-forwarded-host']) || ctx.req.headers.host}`;
    // 1回だけ使える合言葉を作り直す（前のリンクは、使えなくなる）。期限は7日
    const token = randomToken(32);
    db.prepare('UPDATE staff_accounts SET setup_hash = ?, setup_expires = ? WHERE id = ?').run(sha256('setup:' + token), nowMs() + SETUP_LIFETIME, s.id);
    const url = `${origin}/staff.html#setup=${token}`;
    const end = new Date(nowMs() + 9 * HOUR + SETUP_LIFETIME).toISOString();
    const by = `${jpDay(end)} ${end.slice(11, 16)}`;
    await notifier.email(s.email, 'staff_invite', subjectOf(reset ? 'スタッフのパスワードを決め直してください' : 'スタッフとして登録しました'), compose(setting, { name: s.name || null, lines: [
      reset ? `主催者管理者が、スタッフ（${ROLE_LABEL[s.role]}）のパスワードを、リセットしました。` : `令和の競りのスタッフ（${ROLE_LABEL[s.role]}）として、登録しました。`,
      `次のリンクを開いて、パスワードを決めてください（${by}まで。リンクは、1回だけ使えます）。`,
      '',
      url,
      '',
      'お心当たりがない場合は、このメールを破棄してください。',
    ] }));
    // お試し用の設定のときだけ、登録した主催者管理者の画面に、リンクを返す（メールの送信がつながる前に、動きを確かめるため）
    return config.devShowCodes && ctx.staff ? { devSetupUrl: url } : {};
  }
  function createStaff({ loginId, name, role, phone, password: given }) {
    const id = String(loginId ?? '').trim();
    if (!/^[a-z0-9._-]{3,32}$/.test(id)) throw bad('ログイン ID は、半角の英小文字・数字・記号（. _ -）で 3〜32 文字にしてください');
    if (!ROLE_LABEL[role]) throw bad('役割を選んでください');
    const fullName = String(name ?? '').trim().slice(0, 100);
    if (!fullName) throw bad('名前を入力してください');
    const tel = phone ? normalizePhone(phone) : null;
    if (phone && !tel) throw bad('電話番号を、国内の番号で入力してください');
    if (tel && db.prepare('SELECT 1 FROM member_accounts WHERE phone = ? AND phone_verified = 1').get(tel)) throw new HttpError(409, 'この電話番号は、会員として登録されています');
    if (db.prepare('SELECT 1 FROM staff_accounts WHERE login_id = ?').get(id)) throw new HttpError(409, 'このログイン ID は使われています');
    const password = given || randomToken(12);
    const secret = newTotpSecret();
    const info = db.prepare('INSERT INTO staff_accounts (login_id, name, role, phone, password_hash, totp_secret, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, fullName, role, tel, hashPassword(password), secret, nowMs());
    return { id: Number(info.lastInsertRowid), loginId: id, role, initialPassword: password, totpSecret: secret, otpauthUrl: otpauthUrl(secret, id) };
  }

  // 会員の一覧・停止（主催者管理者だけ。FR-AUTH-009）
  route('GET', '/api/members', (ctx) => {
    needStaff(ctx, 'admin');
    // 新しい順に limit 件（既定 500、?limit= で最大 50,000 件）。承認待ちと停止中の会員は、古くても必ず出す（本番運用の評価 C）
    const limit = Math.min(50000, Math.max(500, Math.floor(Number(ctx.url.searchParams.get('limit')) || 500)));
    const rows = db.prepare(`SELECT * FROM member_accounts WHERE id >= coalesce((SELECT id FROM member_accounts ORDER BY id DESC LIMIT 1 OFFSET ?), 0)
      OR (withdrawn_at IS NULL AND rejected_at IS NULL AND (approved_at IS NULL OR suspended = 1)) ORDER BY id DESC`).all(limit - 1);
    const more = db.prepare('SELECT COUNT(*) AS n FROM member_accounts').get().n > rows.length;
    audit(ctx, 'view.members', { after: { count: rows.length } }); // 会員の個人情報の一覧を見た記録
    return { limit, more, members: rows.map((m) => ({ id: m.id, ...memberView(m), approved: !!m.approved_at, rejected: !!m.rejected_at, suspendReason: m.suspend_reason, withdrawn: !!m.withdrawn_at, phone: m.withdrawn_at ? m.withdrawn_phone : m.phone })) };
  });
  // ログイン ID とパスワードを発行して、メールで知らせる。ID は「rw＋会員番号」。パスワードは、そのつど作り直す
  async function issueCredentials(ctx, m, subject, lead) {
    const loginId = m.login_id ?? `rw${String(m.id).padStart(5, '0')}`;
    const password = newPassword();
    db.prepare('UPDATE member_accounts SET login_id = ?, password_hash = ?, login_failed = 0, login_locked_until = 0, updated_at = ? WHERE id = ?').run(loginId, hashPassword(password), nowMs(), m.id);
    db.prepare("DELETE FROM sessions WHERE kind = 'member' AND subject_id = ?").run(m.id); // 前のパスワードでのログインは切る
    const origin = `${ctx.req.headers['x-forwarded-proto'] ?? 'http'}://${(config.trustProxy && ctx.req.headers['x-forwarded-host']) || ctx.req.headers.host}`;
    const sent = await notifier.email(m.email, 'credentials', subject, compose(setting, { name: nameOf(m), lines: [
      ...lead,
      '',
      `ログイン ID: ${loginId}`,
      `パスワード: ${password}`,
      '',
      `${origin}/login.html`,
      '',
      'このパスワードは、ログインのあと、マイページの「個人情報の設定」で、ご自分で決めたものに変えられます。',
      'このメールは、ほかの人に見せたり、転送したりしないでください。',
      'お心当たりがない場合は、このメールにご返信ください。',
    ] }));
    // お試し用の設定のときだけ、発行した内容を画面に返す（メールの送信サービスをつなぐ前に、動きを確かめるため）
    return { loginId, sent, ...(config.devShowCodes ? { devPassword: password } : {}) };
  }
  // 会員登録の承認（主催者管理者だけ）。承認すると、ログイン ID とパスワードを、承認のメールで送る
  route('POST', '/api/members/:id/approve', async (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const m = db.prepare('SELECT * FROM member_accounts WHERE id = ?').get(id);
    if (!m || m.withdrawn_at) throw new HttpError(404, '会員が見つかりません');
    if (m.approved_at) throw new HttpError(409, 'この会員は、すでに承認済みです');
    db.prepare('UPDATE member_accounts SET approved_at = ?, updated_at = ? WHERE id = ?').run(nowMs(), nowMs(), id);
    const issued = await issueCredentials(ctx, m, subjectOf('会員登録を承認しました'), ['会員登録を承認しました。ご登録、ありがとうございます。', '次のログイン ID とパスワードで、ログインしてください。']);
    audit(ctx, 'member.approve', { target: `member:${id}`, after: { loginId: issued.loginId } });
    return { ok: true, ...issued, email: m.email };
  });
  // 承認しない（登録を断る）。電話番号を空けて、同じ番号でもう一度申し込めるようにする
  route('POST', '/api/members/:id/reject', async (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const m = db.prepare('SELECT * FROM member_accounts WHERE id = ?').get(id);
    if (!m || m.withdrawn_at) throw new HttpError(404, '会員が見つかりません');
    if (m.approved_at) throw new HttpError(409, '承認済みの会員は、ここでは断れません（停止を使ってください）');
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw bad('断る理由を入力してください（記録に残ります。本人には送りません）');
    db.prepare('UPDATE member_accounts SET rejected_at = ?, withdrawn_at = ?, withdrawn_phone = phone, phone = ?, updated_at = ? WHERE id = ?').run(nowMs(), nowMs(), `却下:${m.id}`, nowMs(), id);
    dropLogin(id);
    await notifier.email(m.email, 'rejected', subjectOf('会員登録のお申し込みについて'), compose(setting, { name: nameOf(m), lines: [
      'このたびは、会員登録をお申し込みいただき、ありがとうございます。',
      '誠に恐れ入りますが、今回のお申し込みは、お受けできませんでした。',
      '',
      'ご不明な点は、このメールにご返信ください。',
    ] }));
    audit(ctx, 'member.reject', { target: `member:${id}`, reason });
    return { ok: true };
  });
  // ログイン ID とパスワードの発行・再発行（承認済みの会員。前からの会員や、パスワードを忘れた会員に使う）
  route('POST', '/api/members/:id/credentials', async (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const m = db.prepare('SELECT * FROM member_accounts WHERE id = ?').get(id);
    if (!m || m.withdrawn_at) throw new HttpError(404, '会員が見つかりません');
    if (!m.approved_at) throw new HttpError(409, '先に、会員登録を承認してください');
    const issued = await issueCredentials(ctx, m, subjectOf('ログイン ID とパスワードのお知らせ'), ['ログイン ID とパスワードを、発行しました。', 'これまでのパスワードは、使えなくなりました。']);
    audit(ctx, 'member.credentials_issue', { target: `member:${id}`, after: { loginId: issued.loginId } });
    return { ok: true, ...issued, email: m.email };
  });
  route('POST', '/api/members/:id/suspend', (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw bad('停止の理由を入力してください');
    const m = db.prepare('SELECT * FROM member_accounts WHERE id = ?').get(id);
    if (!m) throw new HttpError(404, '会員が見つかりません');
    db.prepare('UPDATE member_accounts SET suspended = 1, suspend_reason = ?, updated_at = ? WHERE id = ?').run(reason, nowMs(), id);
    audit(ctx, 'member.suspend', { target: `member:${id}`, before: { suspended: !!m.suspended }, after: { suspended: true }, reason });
    return { ok: true };
  });
  route('POST', '/api/members/:id/unsuspend', (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const m = db.prepare('SELECT * FROM member_accounts WHERE id = ?').get(id);
    if (!m) throw new HttpError(404, '会員が見つかりません');
    db.prepare('UPDATE member_accounts SET suspended = 0, suspend_reason = NULL, updated_at = ? WHERE id = ?').run(nowMs(), id);
    audit(ctx, 'member.unsuspend', { target: `member:${id}`, before: { suspended: !!m.suspended }, after: { suspended: false } });
    return { ok: true };
  });
  // 認証番号の送信の制限を、スタッフが解く操作は、なくした（発注者の決定。報告書 84 章）。1時間たてば、また送れる

  // ------------------------------------------------------------ 開催（FR-EVT-001・002。主催者管理者だけ）
  const eventView = (e) => ({ id: e.id, title: e.title, startsAt: e.starts_at, endsAt: e.ends_at, venueName: e.venue_name, venueAddress: e.venue_address, highlights: e.highlights, notified: !!e.notified, status: e.status,
    ended: e.phase === 'ended', stale: e.status === 'published' && e.phase !== 'ended' && e.starts_at.slice(0, 10) < todayJst() });
  function eventInput(body) {
    const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
    const e = { title: text(body.title), startsAt: text(body.startsAt, 16), endsAt: text(body.endsAt, 16), venueName: text(body.venueName), venueAddress: text(body.venueAddress, 300), highlights: text(body.highlights, 1000), notified: body.notified === true ? 1 : 0 };
    const isTime = (t) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t);
    if (!e.title) throw bad('開催の名前を入力してください');
    if (!isTime(e.startsAt) || !isTime(e.endsAt) || e.endsAt <= e.startsAt) throw bad('開始と終了の日時を正しく入力してください');
    if (!e.venueName || !e.venueAddress) throw bad('会場の名称と住所を入力してください');
    return e;
  }
  route('GET', '/api/events', (ctx) => {
    needStaff(ctx, 'admin', 'auctioneer');
    return { events: db.prepare('SELECT * FROM events ORDER BY starts_at DESC').all().map(eventView) };
  });
  route('POST', '/api/events', (ctx, body) => {
    needStaff(ctx, 'admin');
    const e = eventInput(body);
    const info = db.prepare('INSERT INTO events (title, starts_at, ends_at, venue_name, venue_address, highlights, notified, venue_code, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(e.title, e.startsAt, e.endsAt, e.venueName, e.venueAddress, e.highlights, e.notified, randomToken(9), nowMs());
    audit(ctx, 'event.create', { target: `event:${info.lastInsertRowid}`, after: e });
    return { ok: true, id: Number(info.lastInsertRowid) };
  });
  route('POST', '/api/events/:id', (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const before = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    if (!before) throw new HttpError(404, '開催が見つかりません');
    const e = eventInput(body);
    // 届出済みの印を外したら、公開も取り下げる（印のない開催は公開できない。FR-EVT-002）
    const status = e.notified ? before.status : 'preparing';
    db.prepare('UPDATE events SET title=?, starts_at=?, ends_at=?, venue_name=?, venue_address=?, highlights=?, notified=?, status=? WHERE id=?').run(e.title, e.startsAt, e.endsAt, e.venueName, e.venueAddress, e.highlights, e.notified, status, id);
    audit(ctx, 'event.update', { target: `event:${id}`, before: eventView(before), after: { ...e, status } });
    return { ok: true };
  });
  route('POST', '/api/events/:id/publish', (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const e = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    if (!e) throw new HttpError(404, '開催が見つかりません');
    if (!e.notified) throw new HttpError(409, '公安委員会への届出済みの印がない開催は、公開できません');
    db.prepare("UPDATE events SET status = 'published' WHERE id = ?").run(id);
    audit(ctx, 'event.publish', { target: `event:${id}`, before: { status: e.status }, after: { status: 'published' } });
    rememberSiteUrl(ctx);
    sendEventMails().catch((err) => console.error('[event-mail]', err)); // 前日を過ぎてから公開した開催にも、すぐ知らせる
    return { ok: true };
  });

  // 開催を、管理画面から終える（本番運用の評価 A5）。進行コンソールの「開催終了」を押し忘れた開催の、請求書を出すため。
  // いまの開催（今日・進行中）なら、進行コンソールと同じ条件（進行中の品がないこと）。過ぎた日の開催なら、残った品をすべて未実施にして終える
  const hooks = { closeOut: null, afterEnd: null };
  /**
   * 主催者管理者への緊急の知らせ（保存の失敗など。本番運用の評価 A8）。管理画面の「知らせ」に残し、主催者管理者と主催者の連絡先へメールで送る。
   * 同じ種類は、1時間に1回まで
   */
  const alertedAt = new Map();
  function alertAdmins(kind, subject, lines) {
    if (nowMs() - (alertedAt.get(kind) ?? 0) < HOUR) return false;
    alertedAt.set(kind, nowMs());
    db.prepare('INSERT INTO notices (at, kind, body) VALUES (?, ?, ?)').run(nowMs(), 'alert', JSON.stringify({ kind, subject }));
    const to = new Set(db.prepare("SELECT email FROM staff_accounts WHERE role = 'admin' AND active = 1 AND email IS NOT NULL").all().map((r) => r.email));
    if (isEmail(setting('org_email'))) to.add(setting('org_email'));
    for (const addr of to) notifier.email(addr, 'alert', subjectOf(`【緊急】${subject}`), compose(setting, { lines })).catch(() => {});
    console.error(`[alert] ${subject}`);
    return true;
  }
  route('POST', '/api/events/:id/end', (ctx, body, id) => {
    const staff = needStaff(ctx, 'admin');
    const e = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    if (!e) throw new HttpError(404, '開催が見つかりません');
    if (e.status !== 'published') throw new HttpError(409, '公開していない開催は、終了できません');
    if (e.phase === 'ended') throw new HttpError(409, 'この開催は、すでに終了しています');
    if (e.starts_at.slice(0, 10) > todayJst()) throw new HttpError(409, 'まだ始まっていない開催は、終了できません');
    if (!hooks.closeOut) throw new HttpError(503, 'いまは終了できません。しばらくしてから、やり直してください');
    const current = activeEvent()?.id === e.id;
    const closed = hooks.closeOut(e.id, { current, actor: staff.name });
    if (closed.error) throw new HttpError(409, closed.error);
    const invoices = billing.onEventEnd(e.id, { ...ctx, system: true });
    db.prepare("UPDATE events SET phase = 'ended', resume_at = NULL WHERE id = ?").run(e.id);
    audit(ctx, 'event.ended', { target: `event:${e.id}`, before: { phase: e.phase ?? null }, after: { phase: 'ended', via: 'admin', notHeld: closed.notHeld, invoices: invoices.length } });
    hooks.afterEnd?.(current);
    return { ok: true, notHeld: closed.notHeld, invoices: invoices.length };
  });

  // ------------------------------------------------------------ 参加手続き（FR-MODE-005、FR-SHIP-007、FR-PAY-009、FR-NUM-001）
  /** 日本時間の、今日の日付（例: 2026-12-05） */
  const todayJst = () => new Date(nowMs() + 9 * HOUR).toISOString().slice(0, 10);

  // ------------------------------------------------------------ 開催のお知らせメール（発注者の指示）
  // 開催の前日（日本時間）から当日の開始までに、受け取ると決めている会員へ1通ずつ送る。1時間ごとの見回りと、公開の操作のときに動く。
  // 前日にサーバーが動いていなかった場合（だれも開かず、休んでいた）は、当日の開始までに送る。開始を過ぎたら送らない。
  // メールに載せるサイトの URL は、設定（POC_SITE_URL）か、主催者管理者が開催を公開したときのページの URL。
  // 会員の画面からの要求の Host は使わない（他人が Host を書き換えて送ると、偽のサイトへのリンクを載せられてしまうため）。
  function rememberSiteUrl(ctx) {
    if (config.siteUrl || !ctx.req) return;
    const host = (config.trustProxy && ctx.req.headers['x-forwarded-host']) || ctx.req.headers.host;
    if (!host || !/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return;
    const url = `${ctx.req.headers['x-forwarded-proto'] === 'https' || config.cookieSecure ? 'https' : 'http'}://${host}`;
    if (setting('site_url') !== url) db.prepare("INSERT INTO settings (key, value) VALUES ('site_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(url);
  }
  const addDaysJst = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
  const jpDate = jpDay;
  function eventMailText(e, a, when) {
    const site = config.siteUrl || setting('site_url');
    const highlights = String(e.highlights ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
    return compose(setting, { name: nameOf(a), lines: [
      `${when}、「${e.title}」を開催します。`,
      '',
      `日時: ${jpDate(e.starts_at)} ${e.starts_at.slice(11, 16)}〜${e.ends_at.slice(11, 16)}`,
      `会場: ${e.venue_name}（${e.venue_address}）`,
      ...(highlights.length ? ['', '目玉の品:', ...highlights.map((h) => `・${h}`)] : []),
      '',
      'オンラインでも、会場でも参加できます。参加の手続きは、当日、ログインしてから行えます。',
      ...(site ? [`${site}/`] : []),
      '',
      // 受信を拒否できること・その URL（特定電子メール法）。ログインせずに止められるリンクにする
      'このお知らせの受信を止める（配信を停止する）ときは、次のページから手続きできます（ログインは不要です）。',
      ...(site ? [`${String(site).replace(/\/+$/, "")}/unsubscribe.html?t=${unsubToken(a)}`] : ['マイページの「個人情報の設定」からも止められます。']),
    ] });
  }
  /** 配信を止めるリンクの合言葉（会員ごと。最初に送るときに作る） */
  function unsubToken(a) {
    if (a.unsub_token) return a.unsub_token;
    const t = randomToken(18);
    db.prepare('UPDATE member_accounts SET unsub_token = ? WHERE id = ?').run(t, a.id);
    a.unsub_token = t;
    return t;
  }
  // 送っている途中で、もう一度呼ばれたら（見回りと公開の操作が重なったとき）、走っている方の終わりを待つ
  let eventMailRun = null;
  function sendEventMails() {
    eventMailRun ??= runEventMails().finally(() => { eventMailRun = null; });
    return eventMailRun;
  }
  async function runEventMails() {
    let sent = 0;
    const today = todayJst();
    const nowJst = new Date(nowMs() + 9 * HOUR).toISOString().slice(0, 16);
    const events = db.prepare("SELECT * FROM events WHERE status = 'published' AND substr(starts_at, 1, 10) BETWEEN ? AND ? AND starts_at > ? AND (phase IS NULL OR phase <> 'ended') ORDER BY starts_at").all(today, addDaysJst(today, 1), nowJst);
    for (const e of events) {
      const when = e.starts_at.slice(0, 10) === today ? '本日' : '明日';
      const subject = `【令和の競り】${when} ${jpDate(e.starts_at)} 開催のお知らせ`;
      // 受け取ると同意した記録のある人だけ（特定電子メール法。同意の記録がない、前の版の会員には送らない）
      const targets = db.prepare(`SELECT * FROM member_accounts a WHERE a.event_mail = 1 AND a.event_mail_consent_at IS NOT NULL AND a.approved_at IS NOT NULL AND a.rejected_at IS NULL AND a.withdrawn_at IS NULL AND a.suspended = 0
        AND NOT EXISTS (SELECT 1 FROM event_mails x WHERE x.event_id = ? AND x.account_id = a.id) ORDER BY a.id`).all(e.id);
      let count = 0;
      for (const a of targets) {
        // 送る前に記録する（送信が失敗しても、同じ人に何度も送り直さない。失敗は、主催者管理者への知らせに残る）
        const fresh = db.prepare('INSERT OR IGNORE INTO event_mails (event_id, account_id, at) VALUES (?, ?, ?)').run(e.id, a.id, nowMs());
        if (!fresh.changes || !isEmail(a.email)) continue;
        await notifier.email(a.email, 'event', subject, eventMailText(e, a, when));
        sent++; count++;
        // 送信サービスの速さの上限（1秒に2通ほど）に当たらないように、少しあける
        if (config.mailIntervalMs) await new Promise((r) => setTimeout(r, config.mailIntervalMs));
      }
      if (count) audit({ system: true }, 'event.mail', { target: `event:${e.id}`, after: { count } });
    }
    return { sent };
  }
  /**
   * いまの開催: 公開中の開催のうち、開催日が今日（日本時間）のもの【前提】。同じ日に2つあれば、開始が早いほう。
   * 開催は月に2〜3回（発注者の決定）。参加手続きと入札は、開催の当日だけ受け付ける。終了した開催（FR-EVT-003）は除く。
   */
  // 日付をまたいでも続けられるように、今日の開催が無ければ、きのう始まって、まだ「開催終了」していない開催を、いまの開催とする
  // （終了の操作を忘れても、翌日のうちは、終了して請求書を出せる）
  // ただし、今日の開催があるとき（終了したものを含む）は、きのうの開催に戻らない（本番運用の評価 A5: 2日続けて開催すると、
  // 2日目を終了した直後に、前日の開催が「いまの開催」に戻っていた）。終了を忘れた開催は、管理画面の「開催」から終えられる
  const activeEvent = () => {
    const q = db.prepare("SELECT * FROM events WHERE status = 'published' AND substr(starts_at, 1, 10) = ? AND (phase IS NULL OR phase <> 'ended') ORDER BY starts_at, id LIMIT 1");
    const today = todayJst();
    const now = q.get(today);
    if (now) return now;
    if (db.prepare("SELECT 1 FROM events WHERE status = 'published' AND substr(starts_at, 1, 10) = ?").get(today)) return null;
    return q.get(new Date(Date.parse(today + 'T00:00:00Z') - DAY).toISOString().slice(0, 10)) ?? null;
  };
  // 開催の予定（トップページのカレンダー用）。公開中の開催だけ。だれでも見られる
  route('GET', '/api/schedule', () => {
    const today = todayJst();
    const pub = (e) => ({ title: e.title, startsAt: e.starts_at, endsAt: e.ends_at, venueName: e.venue_name, venueAddress: e.venue_address, highlights: e.highlights });
    const events = db.prepare("SELECT * FROM events WHERE status = 'published' AND substr(starts_at, 1, 10) >= ? ORDER BY starts_at, id LIMIT 200").all(today.slice(0, 8) + '01');
    const now = activeEvent();
    return { today, todayEvent: now ? pub(now) : null, events: events.map(pub) };
  });
  const participant = (accountId, eventId) => db.prepare('SELECT id, paddle_no, name, account_id, event_id, receive, payment, mode, checked_in_at, checkin_code FROM members WHERE account_id = ? AND event_id = ?').get(accountId, eventId) ?? null;
  const RECEIVE = { pickup: '現地受け取り', ship: '配送' };
  const PAYMENT = { transfer: '銀行振込', cash: '当日現金' };
  /** 会場の QR コードの合言葉が、いまの開催のものか（FR-MODE-002） */
  const venueMatches = (event, code) => !!event?.venue_code && !!code && safeEqual(event.venue_code, String(code));
  route('GET', '/api/participation', (ctx) => {
    const member = needMember(ctx);
    const event = activeEvent();
    const p = event ? participant(member.id, event.id) : null;
    return {
      event: event ? { title: event.title, venueName: event.venue_name } : null,
      // 終わった日は、その旨と、今日落札したかを返す（落札した人を、お支払いの画面へ案内するため。本番運用の評価 B19）
      ended: !event && endedToday(),
      wonToday: !event && endedToday() && !!db.prepare("SELECT 1 FROM bill_lines l JOIN events e ON e.id = l.event_id WHERE l.account_id = ? AND substr(e.starts_at, 1, 10) = ? AND l.kind = 'lot' LIMIT 1").get(member.id, todayJst()),
      joined: !!p, paddle: p?.paddle_no ?? null, receive: p?.receive ?? null, payment: p?.payment ?? null,
      mode: p?.mode ?? null, checkedIn: p ? p.mode !== 'venue' || !!p.checked_in_at : false,
      // 会場の QR コードから来た人か（まだ手続きの前なら、会場参加として手続きできる）
      venue: venueMatches(event, ctx.url.searchParams.get('venue')),
      suspended: !!billing.suspension(member.id), suspendedBy: billing.suspension(member.id),
    };
  });
  // 受け取り方法と支払方法の変更（参加者本人。開催終了まで。FR-PAY-009、FR-SHIP-008）
  // 会場参加を選んだ人が、自分でオンライン参加に直す（発注者の指示。まちがえて選んだ人が、入れないままにならないように）。
  // 来場確認が済んだあとでも、直せる（発注者の決定）。来場確認は取り消すので、会場参加に戻すときは、もう一度受付で確認を受ける。
  // 当日現金を選んでいた場合は、銀行振込にする（すでに当日現金で精算した分は、そのまま）
  route('POST', '/api/my/participation/online', (ctx) => {
    const member = needMember(ctx);
    const event = activeEvent();
    const p = event ? participant(member.id, event.id) : null;
    if (!p) throw new HttpError(409, '参加手続きが済んでいません');
    if (p.mode !== 'venue') return { ok: true, paddle: p.paddle_no, mode: p.mode, checkedIn: true, payment: p.payment };
    const payment = p.payment === 'cash' ? 'transfer' : p.payment;
    db.prepare("UPDATE members SET mode = 'online', payment = ?, checked_in_at = NULL WHERE id = ?").run(payment, p.id);
    audit(ctx, 'participation.change', { target: `participant:${p.id}`, before: { mode: 'venue', payment: p.payment, checkedIn: !!p.checked_in_at }, after: { mode: 'online', payment } });
    return { ok: true, paddle: p.paddle_no, mode: 'online', checkedIn: true, payment, paymentChanged: payment !== p.payment };
  });
  // オンライン参加の人が、自分で会場参加に切り替える（発注者の指示）。受付係の来場確認が済むまでは、入札できなくなる
  route('POST', '/api/my/participation/venue', (ctx) => {
    const member = needMember(ctx);
    const event = activeEvent();
    const p = event ? participant(member.id, event.id) : null;
    if (!p) throw new HttpError(409, '参加手続きが済んでいません');
    if (p.mode === 'venue') return { ok: true, paddle: p.paddle_no, mode: 'venue', checkedIn: !!p.checked_in_at };
    db.prepare("UPDATE members SET mode = 'venue', checked_in_at = NULL WHERE id = ?").run(p.id);
    audit(ctx, 'participation.change', { target: `participant:${p.id}`, before: { mode: 'online' }, after: { mode: 'venue', checkedIn: false } });
    return { ok: true, paddle: p.paddle_no, mode: 'venue', checkedIn: false };
  });
  route('POST', '/api/my/participation', (ctx, body) => {
    const member = needMember(ctx);
    const event = activeEvent();
    const p = event ? participant(member.id, event.id) : null;
    // 開催終了の後は、主催者管理者だけが変えられる（AC-FR-SHIP-008-1）
    if (!p) throw new HttpError(409, '開催が終了したため、ここでは変更できません。変更は主催者に連絡してください');
    const next = { receive: body.receive ?? p.receive, payment: body.payment ?? p.payment };
    if (!Object.hasOwn(RECEIVE, next.receive) || !Object.hasOwn(PAYMENT, next.payment)) throw bad('受け取り方法と支払方法を選んでください');
    if (p.mode === 'online' && next.payment === 'cash') throw bad('当日現金は、会場で参加する方だけが選べます');
    db.transaction(() => {
      db.prepare('UPDATE members SET receive = ?, payment = ? WHERE id = ?').run(next.receive, next.payment, p.id);
      // 受け取り方法は、その開催で落札したすべての明細に使う。発行済みの請求書は出し直さない（FR-INV-006）
      db.prepare('UPDATE bill_lines SET receive = ? WHERE participant_id = ? AND delivered_at IS NULL').run(next.receive, p.id);
    })();
    audit(ctx, 'participation.change', { target: `participant:${p.id}`, before: { receive: p.receive, payment: p.payment }, after: next });
    return { ok: true, ...next };
  });
  route('POST', '/api/join', (ctx, body) => {
    const member = needMember(ctx);
    const event = activeEvent();
    if (!event) throw new HttpError(409, '本日の開催はありません');
    // 会場参加は、会場の QR コードから来た人と、画面で「会場で参加」を選んだ人（発注者の指示）。それ以外は、オンライン参加。
    // どちらの場合も、会場参加の人は、受付係の来場確認が済むまで入札できない（下の bidGate）ので、自分で選んだだけでは会場参加として動けない
    if (body.venueCode && !venueMatches(event, body.venueCode)) throw bad('会場の QR コードが、本日の開催のものではありません。受付で、もう一度読み取ってください');
    const mode = body.venueCode || body.mode === 'venue' ? 'venue' : 'online';
    const errors = {};
    if (!Object.hasOwn(RECEIVE, body.receive)) errors.receive = '受け取り方法を選んでください';
    // オンライン参加の人は、銀行振込だけを選べる。会場参加の人は、当日現金と銀行振込のどちらも選べる（FR-PAY-002）
    if (!Object.hasOwn(PAYMENT, body.payment)) errors.payment = '支払方法を選んでください';
    else if (mode === 'online' && body.payment === 'cash') errors.payment = '当日現金は、会場で参加する方だけが選べます';
    if (Object.keys(errors).length) throw bad('受け取り方法と支払方法の両方に、お答えください', { errors });
    const existing = participant(member.id, event.id);
    // 1回の開催の中では、参加モードは変えられない（FR-MODE-004）。オンラインから会場への変更は、受付係の来場確認で行う
    if (existing) return { ok: true, paddle: existing.paddle_no, mode: existing.mode, checkedIn: existing.mode !== 'venue' || !!existing.checked_in_at };
    // 参加番号は、開催ごとに1から。番号を取るのと書き込むのを、1つの処理にまとめる（2人に同じ番号を振らない）
    const paddle = db.transaction(() => {
      const next = db.prepare('SELECT COALESCE(MAX(paddle_no), 0) + 1 AS n FROM members WHERE event_id = ?').get(event.id).n;
      db.prepare('INSERT INTO members (paddle_no, name, token_hash, account_id, event_id, receive, payment, mode, joined_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(next, member.name, sha256(randomToken()), member.id, event.id, body.receive, body.payment, mode, nowMs());
      return next;
    })();
    audit(ctx, 'event.join', { target: `event:${event.id}`, after: { paddle, receive: body.receive, payment: body.payment, mode } });
    return { ok: true, paddle, mode, checkedIn: mode !== 'venue' };
  });

  // ------------------------------------------------------------ 受付（来場確認。FR-MODE-002・004。主催者管理者・進行役・受付係）
  const venueUrl = (ctx, event) => `${ctx.req.headers['x-forwarded-proto'] ?? 'http'}://${(config.trustProxy && ctx.req.headers['x-forwarded-host']) || ctx.req.headers.host}/bidder.html?venue=${event.venue_code}`;
  const ensureVenueCode = (event) => {
    if (!event.venue_code) { event.venue_code = randomToken(9); db.prepare('UPDATE events SET venue_code = ? WHERE id = ?').run(event.venue_code, event.id); }
    return event;
  };
  route('GET', '/api/reception', (ctx) => {
    needStaff(ctx, 'admin', 'auctioneer', 'reception');
    const event = activeEvent();
    if (!event) return { event: null, participants: [] };
    ensureVenueCode(event);
    const rows = db.prepare(`SELECT m.id, m.paddle_no, m.mode, m.receive, m.payment, m.checked_in_at, a.kind, a.name, a.company, a.contact_name
      FROM members m JOIN member_accounts a ON a.id = m.account_id WHERE m.event_id = ? ORDER BY m.paddle_no`).all(event.id);
    return {
      event: { title: event.title, venueUrl: venueUrl(ctx, event) },
      participants: rows.map((r) => ({
        id: r.id, paddle: r.paddle_no, mode: r.mode, receive: r.receive, payment: r.payment, checkedIn: !!r.checked_in_at,
        name: r.kind === 'b2b' ? `${r.company}　${r.contact_name}` : r.name,
      })),
    };
  });
  // 会場に貼る QR コード（開催ごと）。読み取ると、会場参加の手続きに進む
  route('GET', '/api/reception/qr.svg', async (ctx) => {
    needStaff(ctx, 'admin', 'auctioneer', 'reception');
    const event = activeEvent();
    if (!event) throw new HttpError(404, '本日の開催はありません');
    return { svg: await QRCode.toString(venueUrl(ctx, ensureVenueCode(event)), { type: 'svg', errorCorrectionLevel: 'M', margin: 2 }) };
  });
  // 来場確認の QR コード（報告書 91 章）。会場参加で来場確認を待っている本人に出し、受付係がスマホで読み取る。
  // 中身は参加者ごとの乱数だけ（名前や番号は入れない）。読み取って来場を確認できるのは、受付のログインだけ
  const CHECKIN_PREFIX = 'reiwa-checkin:';
  route('GET', '/api/my/checkin-qr', async (ctx) => {
    const member = needMember(ctx);
    const event = activeEvent();
    const p = event ? participant(member.id, event.id) : null;
    if (!p || p.mode !== 'venue') throw new HttpError(409, '会場参加の手続きが済んでいません');
    let code = p.checkin_code;
    if (!code) { code = randomToken(12); db.prepare('UPDATE members SET checkin_code = ? WHERE id = ?').run(code, p.id); }
    return { paddle: p.paddle_no, qrSvg: await QRCode.toString(CHECKIN_PREFIX + code, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 }) };
  });
  // 受付係が読み取った QR コードから、参加者を探す（来場の確認は、画面で名前を見てから押す）
  route('POST', '/api/reception/scan', (ctx, body) => {
    needStaff(ctx, 'admin', 'auctioneer', 'reception');
    const event = activeEvent();
    if (!event) throw new HttpError(409, '本日の開催はありません');
    const text = String(body?.code ?? '');
    if (!text.startsWith(CHECKIN_PREFIX)) throw new HttpError(404, 'このQRコードは、来場確認のコードではありません。参加者の入札画面に出ているコードを読み取ってください');
    const r = db.prepare(`SELECT m.id, m.paddle_no, m.mode, m.receive, m.payment, m.checked_in_at, a.kind, a.name, a.company, a.contact_name
      FROM members m JOIN member_accounts a ON a.id = m.account_id WHERE m.event_id = ? AND m.checkin_code = ?`).get(event.id, text.slice(CHECKIN_PREFIX.length));
    if (!r) throw new HttpError(404, 'この参加者は、本日の開催に見つかりません。本日の入札画面に出ているコードか、確かめてください');
    return {
      id: r.id, paddle: r.paddle_no, mode: r.mode, receive: r.receive, payment: r.payment, checkedIn: r.mode === 'venue' && !!r.checked_in_at,
      name: r.kind === 'b2b' ? `${r.company}　${r.contact_name}` : r.name,
    };
  });
  // 参加手続きを、受付で代わりに行う（会員登録は済んでいるが、端末で手続きできない人。FR-CON-005 の代理入札の前提にもなる）
  route('POST', '/api/reception/join', (ctx, body) => {
    needStaff(ctx, 'admin', 'auctioneer', 'reception');
    const event = activeEvent();
    if (!event) throw new HttpError(409, '本日の開催はありません');
    // 同じ番号の会員（確かめていない番号）が複数いるときは、どの人か決められないので、止める
    const found = db.prepare('SELECT * FROM member_accounts WHERE phone = ? AND withdrawn_at IS NULL ORDER BY phone_verified DESC, id').all(phoneOf(body));
    if (found.length > 1 && !found[0].phone_verified) throw new HttpError(409, 'この電話番号で登録した会員が複数います。主催者管理者が、会員の一覧で本人を確かめて、電話番号を確定してください');
    const m = found[0];
    if (!m) throw new HttpError(404, 'この電話番号の会員が見つかりません。先に、会員登録をしてもらってください');
    // 承認済みで、退会・却下・停止になっていない会員だけ（本番運用の評価 B6）
    if (!m.approved_at || m.rejected_at || m.withdrawn_at) throw new HttpError(409, 'この会員は、まだ承認されていないか、退会・却下されています。主催者管理者に確かめてください');
    if (billing.suspension(m.id)) throw new HttpError(409, 'この会員は、参加が停止されています。主催者管理者に確かめてください');
    if (!Object.hasOwn(RECEIVE, body.receive) || !Object.hasOwn(PAYMENT, body.payment)) throw bad('受け取り方法と支払方法を、本人に聞いて選んでください');
    const existing = participant(m.id, event.id);
    if (existing) throw new HttpError(409, `この会員は、参加番号 ${existing.paddle_no} で参加手続きが済んでいます`);
    const paddle = db.transaction(() => {
      const next = db.prepare('SELECT COALESCE(MAX(paddle_no), 0) + 1 AS n FROM members WHERE event_id = ?').get(event.id).n;
      db.prepare("INSERT INTO members (paddle_no, name, token_hash, account_id, event_id, receive, payment, mode, joined_at, checked_in_at) VALUES (?,?,?,?,?,?,?,'venue',?,?)")
        .run(next, m.name, sha256(randomToken()), m.id, event.id, body.receive, body.payment, nowMs(), nowMs());
      return next;
    })();
    audit(ctx, 'reception.join', { target: `member:${m.id}`, after: { paddle, receive: body.receive, payment: body.payment, mode: 'venue', checkedIn: true } });
    return { ok: true, paddle };
  });
  route('POST', '/api/reception/:id/checkin', (ctx, body, id) => {
    needStaff(ctx, 'admin', 'auctioneer', 'reception');
    const event = activeEvent();
    const p = event && db.prepare('SELECT * FROM members WHERE id = ? AND event_id = ? AND account_id IS NOT NULL').get(id, event.id);
    if (!p) throw new HttpError(404, '参加者が見つかりません');
    if (p.mode === 'venue' && p.checked_in_at) return { ok: true };
    const before = { mode: p.mode, payment: p.payment, checkedIn: false };
    let payment = p.payment;
    if (p.mode === 'online') {
      // オンライン参加から会場参加への変更は、来場を確認したときだけ（FR-MODE-004）。支払方法は、本人に聞いて選び直す（FR-PAY-002）
      if (!Object.hasOwn(PAYMENT, body.payment)) throw bad('会場参加に切り替えます。支払方法を、本人に聞いて選んでください');
      payment = body.payment;
    }
    db.prepare("UPDATE members SET mode = 'venue', payment = ?, checked_in_at = ? WHERE id = ?").run(payment, nowMs(), id);
    audit(ctx, 'reception.checkin', { target: `participant:${id}`, before, after: { mode: 'venue', payment, checkedIn: true, paddle: p.paddle_no } });
    return { ok: true };
  });

  /** 入札画面の接続（WebSocket）を、ログインのクッキーで確かめる。参加手続きが済んでいれば、その参加者を返す */
  function participantFromCookie(req) {
    const ctx = { req };
    loadSession(ctx);
    if (!ctx.member) return { code: 'LOGIN', message: 'ログインしてください' };
    const event = activeEvent();
    if (!event) return { code: 'NO_EVENT', message: '本日の開催はありません' };
    const p = participant(ctx.member.id, event.id);
    if (!p) return { code: 'NOT_JOINED', message: '参加手続きを済ませてください' };
    // 会場参加は、受付係の来場確認が済むまで有効にならない（FR-MODE-002）
    if (p.mode === 'venue' && !p.checked_in_at) return { code: 'NOT_CHECKED_IN', message: '受付で、来場の確認を受けてください' };
    return { member: p };
  }
  /** 入札してよいか。停止中の会員は SUSPENDED（FR-AUTH-009）。停止の前に受理された入札は、有効のまま */
  const bidGate = (m) => {
    if (!m.account_id) return null; // 検証用の参加者（合言葉の URL）
    // つないだあとで開催が切り替わったら、前の開催の参加番号では入札できない（新しい開催で、参加手続きをやり直す）
    if (m.event_id !== (activeEvent()?.id ?? null)) return 'NOT_JOINED';
    // 承認済みで、退会・却下になっていない会員だけ（代理入札も含む。本番運用の評価 B6）
    const acc = db.prepare('SELECT approved_at, rejected_at, withdrawn_at FROM member_accounts WHERE id = ?').get(m.account_id);
    if (!acc?.approved_at || acc.rejected_at || acc.withdrawn_at) return 'NOT_JOINED';
    // 手動の停止か、未払いによる自動の停止（FR-AUTH-009・015）。どちらか一方でもかかっていれば、入札できない
    if (billing.suspension(m.account_id)) return 'SUSPENDED';
    // つないだあとで会場参加に切り替えた人は、来場確認が済むまで入札できない（別のタブを開いたままでも）
    const now = db.prepare('SELECT mode, checked_in_at FROM members WHERE id = ?').get(m.id);
    if (now?.mode === 'venue' && !now.checked_in_at) return 'NOT_CHECKED_IN';
    return null;
  };

  // ------------------------------------------------------------ 表示する文言
  // 商品は、競りの最中に進行コンソールからその場で登録する（発注者の決定）。事前の登録・審査・カタログは持たない。
  // 送料が含まれないことの表示（FR-SHIP-003）と、返品特約の表示（FR-LEG-002）。だれでも見られる
  route('GET', '/api/terms', () => ({ devShowCodes: config.devShowCodes, sms: config.sms, orgName: setting('org_name'), shippingNotice: setting('shipping_notice'), returnPolicy: setting('return_policy'), premiumRate: billing.premiumRate() }));

  // ------------------------------------------------------------ 主催者設定（FR-ORG-001 の一部）・監査ログ・知らせ
  // 請求書・手数料に使う設定（FR-ORG-001 の一部）。未入力でも動くが、請求書には「（未設定）」と出る
  const BILLING_KEYS = { orgAddress: ['org_address', 200], orgTel: ['org_tel', 40], orgEmail: ['org_email', 254], invoiceRegNo: ['invoice_reg_no', 20], bankAccount: ['bank_account', 200], feeMinimum: ['fee_minimum', 12], feeTaxMode: ['fee_tax_mode', 12], buyerPremiumRate: ['buyer_premium_rate', 5],
    penaltyRateB2b: ['penalty_rate_b2b', 6], penaltyRateB2c: ['penalty_rate_b2c', 6], lateRateB2b: ['late_rate_b2b', 6], lateRateB2c: ['late_rate_b2c', 6] };
  route('GET', '/api/settings', (ctx) => {
    needStaff(ctx, 'admin');
    // fixed: 原本の値で固定している項目（画面では変えられないようにする）。sealFixed: 印鑑も原本で固定
    const FIXED_NAME = { org_name: 'orgName', ...Object.fromEntries(Object.entries(BILLING_KEYS).map(([k, [key]]) => [key, k])) };
    return { orgName: setting('org_name'), kobutsuLicense: setting('kobutsu_license'), returnPolicy: setting('return_policy'), shippingNotice: setting('shipping_notice'), ...Object.fromEntries(Object.entries(BILLING_KEYS).map(([k, [key]]) => [k, setting(key)])),
      fixed: billing.fixedKeys().map((k) => FIXED_NAME[k]), sealFixed: billing.sealFixed() };
  });
  route('POST', '/api/settings', (ctx, body) => {
    needStaff(ctx, 'admin');
    const next = {
      org_name: String(body.orgName ?? '').trim().slice(0, 100),
      // 古物商の許可の表示（古物営業法。例: 「〇〇県公安委員会　第000000000000号」）。サイトの下と競りの画面に出す（報告書 96 章）
      ...(body.kobutsuLicense !== undefined ? { kobutsu_license: String(body.kobutsuLicense ?? '').trim().slice(0, 100) } : {}),
      return_policy: String(body.returnPolicy ?? '').trim().slice(0, 2000),
      shipping_notice: String(body.shippingNotice ?? '').trim().slice(0, 1000),
      ...Object.fromEntries(Object.entries(BILLING_KEYS).filter(([k]) => body[k] !== undefined).map(([k, [key, max]]) => [key, String(body[k] ?? '').trim().slice(0, max)])),
    };
    for (const k of billing.fixedKeys()) next[k] = setting(k); // 原本の値で固定している項目は、変えない
    if (!next.org_name || !next.return_policy || !next.shipping_notice) throw bad('名称・返品特約・送料の表示は、空にできません');
    const before = Object.fromEntries(Object.keys(next).map((k) => [k, setting(k)]));
    for (const [k, v] of Object.entries(next)) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
    audit(ctx, 'settings.update', { target: 'settings', before, after: next });
    return { ok: true };
  });
  // 規約類（利用規約・特定商取引法に基づく表示・プライバシーポリシー。FR-ORG-001）。文面は、主催者管理者が入れる
  const LEGAL = { terms: ['legal_terms', '利用規約'], tokushoho: ['legal_tokushoho', '特定商取引法に基づく表示'], privacy: ['legal_privacy', 'プライバシーポリシー'] };
  route('GET', '/api/legal', () => ({
    orgName: setting('org_name'),
    kobutsuLicense: setting('kobutsu_license'),
    docs: Object.fromEntries(Object.entries(LEGAL).map(([k, [key, title]]) => [k, { title, body: setting(key) }])),
  }));
  route('POST', '/api/settings/legal', (ctx, body) => {
    needStaff(ctx, 'admin');
    const changed = [];
    for (const [k, [key]] of Object.entries(LEGAL)) {
      if (body[k] === undefined) continue;
      const v = String(body[k] ?? '').trim().slice(0, 60000);
      if (v !== setting(key)) changed.push(k);
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, v);
    }
    audit(ctx, 'settings.legal', { target: 'legal', after: { changed } });
    return { ok: true };
  });
  route('GET', '/api/audit', (ctx) => {
    needStaff(ctx, 'admin', 'operator');
    return { entries: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300').all() };
  });
  route('GET', '/api/notices', (ctx) => {
    needStaff(ctx, 'admin');
    return { notices: db.prepare('SELECT * FROM notices ORDER BY id DESC LIMIT 100').all() };
  });

  // ------------------------------------------------------------ 受け口
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      // 上限を超えたら、残りは読み捨ててから断る（途中で切ると、端末に理由が届かない）。上限の2倍を超えて送り続ける相手は切る
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { chunks.length = 0; if (size > limit * 2) req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => (size > limit ? reject(new HttpError(413, '送信が大きすぎます')) : resolve(Buffer.concat(chunks))));
      req.on('close', () => reject(new HttpError(413, '送信が大きすぎます')));
      req.on('error', reject);
    });
  }
  function sendJson(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  async function handle(req, res, url) {
    const ctx = { req, res, url, ip: clientIp(req, config) };
    try {
      loadSession(ctx);
      const found = routes.map((r) => ({ r, m: r.re.exec(url.pathname) })).filter((x) => x.m);
      const hit = found.find((x) => x.r.method === req.method);
      if (!hit) throw new HttpError(found.length ? 405 : 404, found.length ? 'この方法では呼び出せません' : '見つかりません');
      let body = {};
      if (req.method === 'POST') {
        // よそのサイトのページからの送信を断る（クッキーは SameSite=Lax だが、念のため出どころも確かめる）
        const origin = req.headers.origin;
        if (origin) {
          let host = '';
          try { host = new URL(origin).host; } catch { /* 形の崩れた Origin は断る */ }
          if (host !== req.headers.host && !(config.trustProxy && host === req.headers['x-forwarded-host']) && !config.allowedOrigins.includes(origin)) throw new HttpError(403, 'このページからは操作できません');
        }
        // 印鑑の画像だけは、大きさの上限を広げる（2MB まで）
        const raw = await readBody(req, url.pathname === '/api/settings/seal' ? 3 * 1024 * 1024 : url.pathname === '/api/settings/legal' ? 512 * 1024 : 64 * 1024);
        if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'JSON で送ってください');
        try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw bad('JSON として読めません'); }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('JSON のオブジェクトで送ってください');
      }
      const result = await hit.r.handler(ctx, body, ...hit.m.slice(1).map(Number));
      // 書き込みをした操作の返事は、その書き込みの控えが、外の保存先に届いてから出す（返事のあとで、無かったことにならないように）
      if (req.method !== 'GET') await durable();
      if (result?.redirect) { res.writeHead(302, { location: result.redirect }); return res.end(); }
      if (result?.file) { res.writeHead(200, { 'content-type': result.file.type, 'content-disposition': `attachment; filename="${result.file.name}"`, 'cache-control': 'no-store' }); return res.end(result.file.body); }
      if (result?.image) { res.writeHead(200, { 'content-type': result.image.type, 'cache-control': 'no-store' }); return res.end(result.image.body); }
      if (result?.svg) { res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' }); return res.end(result.svg); }
      sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { ok: false, message: err.message, ...err.extra });
      console.error('[api]', err);
      sendJson(res, 500, { ok: false, message: 'サーバーで問題が起きました。時間をおいて、やり直してください' });
    }
  }

  // ------------------------------------------------------------ 進行コンソール用（FR-CON、FR-EVT-003）
  /** 進行コンソールの接続を、スタッフのログインで確かめる。進行できるのは、主催者管理者と進行役（8.14） */
  function staffFromCookie(req) {
    const ctx = { req };
    loadSession(ctx);
    if (!ctx.staff) return { code: 'LOGIN', message: 'スタッフのログインが必要です' };
    if (!['admin', 'auctioneer', 'caller'].includes(ctx.staff.role)) return { code: 'FORBIDDEN', message: '競りの進行は、主催者管理者・進行役・オークショニアだけができます' };
    return { staff: { id: ctx.staff.id, name: ctx.staff.name, role: ctx.staff.role, account: true } };
  }
  /** ログインしているか（会員かスタッフ）。トップページを開いた人を、ログインの画面へ送るかどうかに使う */
  /** ログイン中の会員の番号（ログインが切れていれば null）。開いたままの入札画面の、確かめ直しに使う */
  function memberIdFromCookie(req) {
    const ctx = { req };
    loadSession(ctx);
    return ctx.member && !ctx.member.withdrawn_at ? ctx.member.id : null;
  }
  function signedIn(req) {
    const ctx = { req };
    loadSession(ctx);
    return !!(ctx.member && !ctx.member.withdrawn_at) || !!ctx.staff;
  }
  /** 会場の大型モニター（FR-CON-007）の接続。スタッフのログインがあれば、どの役割でも見られる（見るだけ） */
  function viewerFromCookie(req) {
    const ctx = { req };
    loadSession(ctx);
    return ctx.staff ? { staff: { id: ctx.staff.id, name: ctx.staff.name, role: ctx.staff.role, account: true } } : { code: 'LOGIN', message: 'スタッフのログインが必要です' };
  }
  /** 開催の進み具合（参加者の画面と進行コンソールに送る）。phase: null（開始前）/ running（進行中）/ break（休憩）*/
  /** 今日の開催が、もう終わっているか（再接続した会場モニターが、終了の表示を続けるため。報告書 80 章） */
  const endedToday = () => !activeEvent() && !!db.prepare("SELECT 1 FROM events WHERE status = 'published' AND substr(starts_at, 1, 10) = ? AND phase = 'ended'").get(todayJst());
  const eventState = () => {
    const e = activeEvent();
    return e ? { id: e.id, title: e.title, phase: e.phase ?? null, resumeAt: e.phase === 'break' ? e.resume_at : null, endsAt: e.ends_at.slice(11) } : null;
  };
  function setPhase(staff, phase, resumeAt = null) {
    const e = activeEvent();
    if (!e) throw new HttpError(409, '本日の開催はありません');
    if ((e.phase ?? null) === phase && (e.resume_at ?? null) === resumeAt) return eventState();
    db.prepare('UPDATE events SET phase = ?, resume_at = ? WHERE id = ?').run(phase, resumeAt, e.id);
    audit({ staff, system: true }, `event.${phase}`, { target: `event:${e.id}`, before: { phase: e.phase ?? null }, after: { phase, resumeAt } });
    return eventState();
  }
  /** 代理入札の対象（FR-CON-005）: いまの開催で、会場参加として来場確認が済んでいる参加者 */
  function proxyTarget(paddle) {
    const e = activeEvent();
    if (!e) throw new HttpError(409, '本日の開催はありません');
    const p = db.prepare('SELECT id, paddle_no, name, account_id, event_id, mode, checked_in_at FROM members WHERE event_id = ? AND paddle_no = ?').get(e.id, Number(paddle));
    if (!p) throw new HttpError(404, `参加番号 ${paddle} の参加者が見つかりません`);
    if (p.mode !== 'venue' || !p.checked_in_at) throw new HttpError(409, '代理入札は、会場参加で、来場確認が済んでいる人にだけ行えます');
    return p;
  }
  return {
    hooks, alertAdmins, purgeExpiredPii, handle, createStaff, inviteStaff, audit, participantFromCookie, bidGate, sendEventMails, eventId: () => activeEvent()?.id ?? null,
    staffFromCookie, viewerFromCookie, signedIn, memberIdFromCookie, eventState, endedToday, setPhase, proxyTarget, billing,
  };
}
