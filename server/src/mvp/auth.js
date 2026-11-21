// 認証の土台（セッション・いつもの端末・試行の制限・認証番号・ログインの誤りの数え方）（報告書 122 章で、api.js から分けた。中身は、分ける前と同じ）
import crypto from 'node:crypto';
import { HOUR, HttpError, MEMBER_IDLE, MIN, OTP_MAX_ATTEMPTS, OTP_MAX_FAILS_PER_HOUR, OTP_SENDS_PER_HOUR, OTP_TTL, REGISTER_LIFETIME, ROLE_LABEL, STAFF_LIFETIME, bad } from './shared.js';
import { isEmail, newOtpCode, normalizePhone, randomToken, safeEqual, sha256, verifyPasswordAsync } from './security.js';
import { compose, subjectOf } from './mails.js';

export function createAuth(deps) {
  const { PREFECTURES, config, db, notifier, nowMs, setting, toHalfDigits, toKatakana } = deps;
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
  // 印には、いまのパスワード（のハッシュ）も混ぜる。パスワードを変える・再発行すると、前の端末の印は使えなくなる
  const deviceSig = (kind, id) => {
    const row = kind === 's' ? db.prepare('SELECT password_hash AS h FROM staff_accounts WHERE id = ?').get(id) : db.prepare('SELECT password_hash AS h FROM member_accounts WHERE id = ?').get(id);
    return crypto.createHmac('sha256', deviceKey).update(`${kind}:${id}:${row?.h ?? ''}`).digest('base64url');
  };
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
    db.prepare('INSERT INTO otp_codes (phone, code_hash, expires_at, attempts, fails, fails_from) VALUES (?,?,?,0,0,?) ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, fails = CASE WHEN otp_codes.fails_from > excluded.fails_from - 3600000 THEN otp_codes.fails ELSE 0 END, fails_from = CASE WHEN otp_codes.fails_from > excluded.fails_from - 3600000 THEN otp_codes.fails_from ELSE excluded.fails_from END')
      .run(phone, sha256(phone + ':' + code), now + OTP_TTL, now);
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
    // 送り直しても、誤りの回数は消えない: 1時間に、合わせて10回まちがえたら、その宛先は1時間使えない（送り直しを挟んだ総当たりを防ぐ）
    if (row && row.fails >= OTP_MAX_FAILS_PER_HOUR && nowMs() - row.fails_from < HOUR) throw new HttpError(429, '認証番号のまちがいが続いたため、しばらく使えません。1時間ほど待ってから、もう一度お試しください');
    if (!row || nowMs() > row.expires_at || row.attempts >= OTP_MAX_ATTEMPTS) throw fail;
    if (!safeEqual(row.code_hash, sha256(phone + ':' + String(code ?? '').trim()))) {
      db.prepare('UPDATE otp_codes SET attempts = attempts + 1, fails = fails + 1 WHERE phone = ?').run(phone);
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
  const passwordMatches = async (input, hash) => {
    const raw = String(input ?? '');
    if (await verifyPasswordAsync(raw, hash)) return true;
    const trimmed = raw.trim();
    return trimmed !== raw && await verifyPasswordAsync(trimmed, hash);
  };
  // ログインの誤りの数え方（報告書 121 章）: 「この ID × この接続元」で数えて、その接続元だけを止める。
  // これまでは、ID ごとに数えていたので、連番のログイン ID に、わざと誤ったパスワードを入れるだけで、ほかの会員を締め出せた。
  // パスワードを変えると（再発行を含む）、鍵が変わるので、止めは消える。覚えるのは、動いているあいだだけ
  const pairFails = new Map();
  const loginGuard = (kind, row, ctx, { max, lockMs }) => {
    const key = `${kind}|${row.id}|${ctx.ip}|${String(row.password_hash ?? '').slice(-12)}`;
    return {
      lockedUntil: (now) => { const e = pairFails.get(key); return e && e.until > now ? e.until : 0; },
      failed: (now) => {
        const e = pairFails.get(key) ?? { n: 0, until: 0, at: now };
        e.n++; e.at = now;
        if (e.n >= max) { e.n = 0; e.until = now + lockMs; }
        pairFails.set(key, e);
        // 増えすぎたら、古いものから捨てる（止めの最中のものは、残す）
        if (pairFails.size > 20000) for (const [k, v] of pairFails) { if (v.until <= now && now - v.at > lockMs) pairFails.delete(k); }
        return e.until > now;
      },
      passed: () => pairFails.delete(key),
    };
  };
  function credentialErrors(body, errors, { memberId = null, need = false } = {}) {
    const loginId = normLoginId(body.loginId), password = String(body.password ?? '');
    if (!need && !loginId && !password) return null;
    if (!/^[a-z0-9._-]{4,32}$/.test(loginId)) errors.loginId = 'ログイン ID は、半角の英数字と . _ - で、4〜32文字にしてください';
    else if (db.prepare('SELECT 1 FROM member_accounts WHERE login_id = ? AND id IS NOT ?').get(loginId, memberId)) errors.loginId = 'このログイン ID は、使われています。別の ID にしてください';
    // 「rw＋数字」は、承認のときに発行する ID の形。自分に発行されたもの以外は、選べない（これから承認される人の ID を、先に取られないように）
    else if (/^rw\d+$/.test(loginId) && db.prepare('SELECT login_id FROM member_accounts WHERE id IS ?').get(memberId)?.login_id !== loginId) errors.loginId = 'このログイン ID は、使えません。別の ID にしてください';
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
  return { checkOtp, credentialErrors, endSession, loadSession, loginGuard, loginTarget, needMember, needStaff, newPassword, normLoginId, passwordMatches, personFrom, phoneOf, registerKey, sendOtp, startSession, throttle, trustDevice, trustedDevice };
}
