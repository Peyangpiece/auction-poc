import { migrate } from '../migrate.js';
// MVP の 1（会員登録・認証・スタッフ）の API と、開催・主催者設定・監査ログ。
// 商品は、競りの最中に進行コンソールからその場で登録する（発注者の決定）ので、事前の登録・審査・カタログは持たない。
// 権限は、必ずここ（サーバーの側）で確かめる。画面でボタンを隠すだけにはしない（本仕様 8.14）。
import fs from 'node:fs';
import path from 'node:path';
import { MVP_SCHEMA, DEFAULT_SETTINGS } from './schema.js';
import { randomToken, sha256, clientIp } from './security.js';
import { Notifier, outboxSender, httpMailSender } from './notify.js';
import { compose, subjectOf } from './mails.js';
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
import { createAuth } from './auth.js';
import { createMembers } from './members.js';
import { createReception } from './reception.js';
import { createEvents } from './events.js';
import { createStaffApi } from './staff.js';

import { DAY, HttpError, bad, siteOrigin, parseJson } from './shared.js';

export function createApi({ store, config, nowMs, persistStatus = () => null, durable = () => null, healthDetail = () => ({}) }) {
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
  // ここから下の、形の変更は、番号を付けて1回ずつ行う（migrate.js。一度配った手順は、書き換えない）
  migrate(db, 'api', [
    { v: 1, name: 'お知らせメールの失敗の回数', up: (d) => d.exec('CREATE TABLE event_mail_fails (event_id INTEGER NOT NULL, account_id INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (event_id, account_id))') },
    { v: 2, name: '開催を始めた時刻', up: (d) => d.exec('ALTER TABLE events ADD COLUMN started_at REAL') },
  ], { nowMs });
  for (const [col, type] of [['fails', 'INTEGER NOT NULL DEFAULT 0'], ['fails_from', 'REAL NOT NULL DEFAULT 0']]) {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('otp_codes') WHERE name = ?").get(col)) db.exec(`ALTER TABLE otp_codes ADD COLUMN ${col} ${type}`);
  }
  // ログイン ID は、会員のあいだで重ならない（承認のときに発行する「rw＋番号」と、本人が決めた ID がぶつからないように）
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS member_accounts_login_id ON member_accounts(login_id) WHERE login_id IS NOT NULL'); } catch (e) { console.error('[migrate] ログイン ID が重なっている会員がいるため、重なりを防ぐ索引を作れません:', e.message); }
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

  // ------------------------------------------------------------ セッション（auth.js）
  const { checkOtp, credentialErrors, endSession, loadSession, loginGuard, loginTarget, needMember, needStaff, newPassword, normLoginId, passwordMatches, personFrom, phoneOf, registerKey, sendOtp, startSession, throttle, trustDevice, trustedDevice } = createAuth({ PREFECTURES, config, db, notifier, nowMs, setting, toHalfDigits, toKatakana });

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
    const origin = siteOrigin(config, ctx.req);
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

  // ------------------------------------------------------------ 会員の受け口（members.js）
  createMembers({ audit, checkOtp, loginGuard, nameOf, notifier, setting, config, credentialErrors, db, dropLogin, endSession, loginTarget, lookupPostal, memberView, needMember, needStaff, normLoginId, nowMs, passwordMatches, persistStatus, personFrom, phoneOf, registerKey, route, sendEmailVerification, sendOtp, startSession, throttle, toHalfDigits, trustDevice, trustedDevice });

  // ------------------------------------------------------------ スタッフ（staff.js）
  const { createStaff, inviteStaff } = createStaffApi({ audit, config, db, loginGuard, dropLogin, healthDetail, memberView, nameOf, needStaff, newPassword, notifier, nowMs, route, setting, startSession, throttle, trustDevice, trustedDevice });

  // ------------------------------------------------------------ 開催（events.js）
  const { PAYMENT, RECEIVE, activeEvent, alertAdmins, endedToday, hooks, participant, sendEventMails } = createEvents({ audit, billing, config, db, nameOf, needMember, needStaff, notifier, nowMs, route, setting });

  // ------------------------------------------------------------ 受付（reception.js）
  const { bidGate, participantFromCookie } = createReception({ PAYMENT, RECEIVE, activeEvent, audit, billing, config, db, loadSession, needMember, needStaff, nowMs, participant, phoneOf, route });

  // ------------------------------------------------------------ 表示する文言
  // 商品は、競りの最中に進行コンソールからその場で登録する（発注者の決定）。事前の登録・審査・カタログは持たない。
  // 送料が含まれないことの表示（FR-SHIP-003）と、返品特約の表示（FR-LEG-002）。だれでも見られる
  // 返品特約の「【仮の文言。…】」の印は、利用者には見せない（主催者管理者の設定の画面と、公開の前の確かめには、残る。報告書 120 章）
  route('GET', '/api/terms', () => ({ devShowCodes: config.devShowCodes, sms: config.sms, orgName: setting('org_name'), shippingNotice: setting('shipping_notice'), returnPolicy: setting('return_policy').replace(/^【仮[^】]*】\s*/, ''), premiumRate: billing.premiumRate() }));

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
      ...Object.fromEntries(Object.entries(BILLING_KEYS).filter(([k]) => body[k] !== undefined).map(([k, [key, max]]) => [key, String(body[k] ?? '').trim().slice(0, Number(max))])),
    };
    for (const k of billing.fixedKeys()) next[k] = setting(k); // 原本の値で固定している項目は、変えない
    if (!next.org_name || !next.return_policy || !next.shipping_notice) throw bad('名称・返品特約・送料の表示は、空にできません');
    const before = Object.fromEntries(Object.keys(next).map((k) => [k, setting(k)]));
    for (const [k, v] of Object.entries(next)) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
    audit(ctx, 'settings.update', { target: 'settings', before, after: next });
    // 請求書に載る項目が変わったら、まだ送っていない請求書を作り直す
    const onInvoice = ['org_name', 'org_address', 'org_tel', 'org_email', 'invoice_reg_no', 'bank_account'];
    const rerendered = onInvoice.some((k) => k in next && next[k] !== before[k]) ? billing.rerenderUnsent() : 0;
    return { ok: true, rerendered };
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
        try { body = raw.length ? parseJson(raw.toString('utf8')) : {}; } catch { throw bad('JSON として読めません'); }
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
  const eventState = () => {
    const e = activeEvent();
    // startsAt: 開始の予定（HH:MM）。startedAt: 進行役が「開催を始める」を押した時刻（まだなら null）。経過時間の起点
    return e ? { id: e.id, title: e.title, phase: e.phase ?? null, resumeAt: e.phase === 'break' ? e.resume_at : null, startsAt: e.starts_at.slice(11), endsAt: e.ends_at.slice(11), startedAt: e.started_at ?? null,
      stale: e.starts_at.slice(0, 10) < new Date(nowMs() + 9 * 3600000).toISOString().slice(0, 10) } : null; // stale: きのうの開催（終了し忘れ）
  };
  function setPhase(staff, phase, resumeAt = null) {
    const e = activeEvent();
    if (!e) throw new HttpError(409, '本日の開催はありません');
    if ((e.phase ?? null) === phase && (e.resume_at ?? null) === resumeAt) return eventState();
    db.prepare('UPDATE events SET phase = ?, resume_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?').run(phase, resumeAt, phase === 'running' ? nowMs() : null, e.id);
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
