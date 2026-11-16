// MVP の 1（会員登録・認証・スタッフ）の API と、開催・主催者設定・監査ログ。
// 商品は、競りの最中に進行コンソールからその場で登録する（発注者の決定）ので、事前の登録・審査・カタログは持たない。
// 権限は、必ずここ（サーバーの側）で確かめる。画面でボタンを隠すだけにはしない（本仕様 8.14）。
import fs from 'node:fs';
import path from 'node:path';
import { MVP_SCHEMA, DEFAULT_SETTINGS } from './schema.js';
import {
  randomToken, sha256, safeEqual, hashPassword, verifyPassword, newTotpSecret, verifyTotp, otpauthUrl,
  newOtpCode, normalizePhone, isEmail,
} from './security.js';
import { Notifier, outboxSender } from './notify.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OTP_TTL = 5 * MIN;            // 認証番号の有効期限（FR-AUTH-004）
const OTP_MAX_ATTEMPTS = 5;         // 入力の誤り5回で無効
const OTP_SENDS_PER_HOUR = 5;       // 同じ番号へ1時間に5回まで
const MEMBER_IDLE = 30 * DAY;       // 会員: 最後に操作してから30日（FR-AUTH-005）
const STAFF_LIFETIME = 12 * HOUR;   // スタッフ: 12時間（FR-AUTH-012）
const REGISTER_LIFETIME = 15 * MIN; // SMS 認証から登録の完了まで
const LOCK_AFTER = 5;               // パスワードの誤り5回で
const LOCK_FOR = 15 * MIN;          // 15分ロック
const ROLE_LABEL = { admin: '主催者管理者', auctioneer: '進行役', reception: '受付係' };

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const bad = (message, extra) => new HttpError(400, message, extra);

export function createApi({ store, config, nowMs }) {
  const db = store.db;
  db.exec(MVP_SCHEMA);
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);

  const notifier = new Notifier(
    outboxSender(path.join(config.dataDir, 'outbox')),
    (failure) => db.prepare('INSERT INTO notices (at, kind, body) VALUES (?, ?, ?)').run(nowMs(), 'send_failed', JSON.stringify(failure)),
  );
  const setting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? '';

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
  function throttle(ctx) {
    if (!(config.authRatePerMin > 0)) return;
    const now = nowMs();
    const list = (attempts.get(ctx.ip) ?? []).filter((t) => now - t < MIN);
    if (list.length >= config.authRatePerMin) throw new HttpError(429, '試行が多すぎます。1分ほど待ってから、やり直してください');
    list.push(now);
    attempts.set(ctx.ip, list);
  }

  // ------------------------------------------------------------ SMS の認証番号（FR-AUTH-004・010）
  async function sendOtp(phone) {
    const now = nowMs();
    const sent = db.prepare('SELECT COUNT(*) AS n FROM otp_sends WHERE phone = ? AND at > ?').get(phone, now - HOUR).n;
    if (sent >= OTP_SENDS_PER_HOUR) throw new HttpError(429, '認証番号の送信が上限に達しました。1時間ほど待つか、会場の受付にお申し出ください');
    const code = newOtpCode();
    db.prepare('INSERT INTO otp_codes (phone, code_hash, expires_at, attempts) VALUES (?,?,?,0) ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0')
      .run(phone, sha256(phone + ':' + code), now + OTP_TTL);
    db.prepare('INSERT INTO otp_sends (phone, at) VALUES (?, ?)').run(phone, now);
    // 送信の失敗による自動の再送（IF-EXT-003）は、上の回数に数えない（1回の送信として記録済み）
    await notifier.sms(phone, 'otp', `【NEWS ライブオークション】認証番号は ${code} です。5分以内に入力してください。`);
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

  // ------------------------------------------------------------ 会員
  const memberView = (m) => ({
    kind: m.kind, name: m.name, phone: m.phone, email: m.email, emailVerified: !!m.email_verified, address: m.address,
    shipTo: m.ship_to, company: m.company, contactName: m.contact_name, billing: m.billing, suspended: !!m.suspended,
  });
  async function sendEmailVerification(ctx, member) {
    const token = randomToken();
    db.prepare('INSERT INTO email_tokens (token_hash, member_id, expires_at) VALUES (?,?,?)').run(sha256(token), member.id, nowMs() + DAY);
    const origin = `${ctx.req.headers['x-forwarded-proto'] ?? 'http'}://${ctx.req.headers.host}`;
    await notifier.email(member.email, 'verify_email', 'メールアドレスの確認', `次のリンクを開いて、メールアドレスを確認してください（24時間以内）。\n${origin}/api/email/verify?token=${token}`);
  }

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:id/g, '(\\d+)') + '$'), handler });

  route('GET', '/api/me', (ctx) => ({
    member: ctx.member ? memberView(ctx.member) : null,
    staff: ctx.staff ? { loginId: ctx.staff.login_id, name: ctx.staff.name, role: ctx.staff.role, roleLabel: ROLE_LABEL[ctx.staff.role] } : null,
    registering: !!ctx.registerPhone,
  }));

  // 登録: 電話番号 → SMS 認証 → 入力
  route('POST', '/api/register/start', async (ctx, body) => {
    throttle(ctx);
    const phone = phoneOf(body);
    // スタッフとして登録された番号では、会員登録できない（FR-AUTH-013）
    if (db.prepare('SELECT 1 FROM staff_accounts WHERE phone = ?').get(phone)) throw new HttpError(409, 'この電話番号では登録できません');
    if (db.prepare('SELECT 1 FROM member_accounts WHERE phone = ?').get(phone)) throw new HttpError(409, 'この電話番号は登録済みです。ログインしてください', { login: true });
    await sendOtp(phone);
    return { ok: true };
  });
  route('POST', '/api/register/verify', (ctx, body) => {
    throttle(ctx);
    const phone = phoneOf(body);
    checkOtp(phone, body.code);
    startSession(ctx, 'register', null, REGISTER_LIFETIME, phone);
    return { ok: true };
  });
  route('POST', '/api/register/complete', async (ctx, body) => {
    const phone = ctx.registerPhone;
    if (!phone) throw new HttpError(401, '先に、電話番号の確認を済ませてください');
    const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
    const kind = body.kind === 'b2b' ? 'b2b' : body.kind === 'b2c' ? 'b2c' : null;
    const errors = {};
    if (!kind) errors.kind = '法人か個人かを選んでください';
    const name = text(body.name); if (!name) errors.name = '氏名を入力してください';
    const email = text(body.email, 254); if (!isEmail(email)) errors.email = 'メールアドレスを正しく入力してください';
    const address = text(body.address, 300); if (!address) errors.address = '住所を入力してください';
    const company = text(body.company), contactName = text(body.contactName), billing = text(body.billing, 300);
    if (kind === 'b2b') {
      if (!company) errors.company = '会社名を入力してください';
      if (!contactName) errors.contactName = '担当者名を入力してください';
      if (!billing) errors.billing = '請求先を入力してください';
    }
    // 個人は、18歳以上であることの申告が必須（FR-AUTH-003）
    if (kind === 'b2c' && body.adult !== true) errors.adult = '18歳以上であることを確認してください';
    if (Object.keys(errors).length) throw bad('入力を確かめてください', { errors });
    if (db.prepare('SELECT 1 FROM member_accounts WHERE phone = ?').get(phone) || db.prepare('SELECT 1 FROM staff_accounts WHERE phone = ?').get(phone)) {
      throw new HttpError(409, 'この電話番号では登録できません');
    }
    const now = nowMs();
    const info = db.prepare(`INSERT INTO member_accounts (kind, name, phone, email, address, ship_to, company, contact_name, billing, adult_declared, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(kind, name, phone, email, address, text(body.shipTo, 300) || null,
      kind === 'b2b' ? company : null, kind === 'b2b' ? contactName : null, kind === 'b2b' ? billing : null, kind === 'b2c' ? 1 : 0, now, now);
    const member = db.prepare('SELECT * FROM member_accounts WHERE id = ?').get(info.lastInsertRowid);
    endSession(ctx);
    startSession(ctx, 'member', member.id, MEMBER_IDLE);
    audit({ ...ctx, member }, 'member.register', { target: `member:${member.id}`, after: { kind } });
    await sendEmailVerification(ctx, member); // 確認が済んでいなくても入札はできる（FR-AUTH-011）
    return { ok: true, member: memberView(member) };
  });

  // ログイン: 電話番号と SMS の認証番号。パスワードは使わない（FR-AUTH-010）
  route('POST', '/api/login/start', async (ctx, body) => {
    throttle(ctx);
    const phone = phoneOf(body);
    // 登録のない番号でも、同じ返事をする（どの番号が登録済みかを、外から調べられないようにする）
    if (db.prepare('SELECT 1 FROM member_accounts WHERE phone = ?').get(phone)) await sendOtp(phone);
    return { ok: true };
  });
  route('POST', '/api/login/verify', (ctx, body) => {
    throttle(ctx);
    const phone = phoneOf(body);
    checkOtp(phone, body.code);
    const member = db.prepare('SELECT * FROM member_accounts WHERE phone = ?').get(phone);
    if (!member) throw new HttpError(400, '認証番号が正しくないか、期限が切れています。番号を送り直してください', { resend: true });
    startSession(ctx, 'member', member.id, MEMBER_IDLE);
    return { ok: true, member: memberView(member) };
  });
  route('POST', '/api/logout', (ctx) => { endSession(ctx); return { ok: true }; });
  route('POST', '/api/email/resend', async (ctx) => {
    const member = needMember(ctx);
    if (member.email_verified) return { ok: true };
    throttle(ctx);
    await sendEmailVerification(ctx, member);
    return { ok: true };
  });
  route('GET', '/api/email/verify', (ctx) => {
    const token = ctx.url.searchParams.get('token') ?? '';
    const row = db.prepare('SELECT * FROM email_tokens WHERE token_hash = ?').get(sha256(token));
    const ok = !!row && nowMs() <= row.expires_at;
    if (ok) {
      db.prepare('UPDATE member_accounts SET email_verified = 1, updated_at = ? WHERE id = ?').run(nowMs(), row.member_id);
      db.prepare('DELETE FROM email_tokens WHERE member_id = ?').run(row.member_id);
    }
    return { redirect: `/mypage.html?email=${ok ? 'verified' : 'expired'}` };
  });

  // ------------------------------------------------------------ スタッフ
  route('POST', '/api/staff/login', (ctx, body) => {
    throttle(ctx);
    const staff = db.prepare('SELECT * FROM staff_accounts WHERE login_id = ?').get(String(body.loginId ?? ''));
    const fail = new HttpError(401, 'ID・パスワード・認証コードのどれかが違います');
    if (!staff || !staff.active) throw fail;
    const now = nowMs();
    if (staff.locked_until > now) throw new HttpError(423, `誤りが続いたため、ロックしています。${Math.ceil((staff.locked_until - now) / MIN)} 分後にやり直してください`);
    // パスワードと二段階認証の両方を確かめる。どちらが違ったかは伝えない
    const ok = verifyPassword(body.password ?? '', staff.password_hash) && verifyTotp(staff.totp_secret, body.code, Date.now());
    if (!ok) {
      const failed = staff.failed_count + 1;
      const lock = failed >= LOCK_AFTER;
      db.prepare('UPDATE staff_accounts SET failed_count = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : failed, lock ? now + LOCK_FOR : 0, staff.id);
      if (lock) audit({ ...ctx, system: true }, 'staff.locked', { target: `staff:${staff.id}` });
      throw fail;
    }
    db.prepare('UPDATE staff_accounts SET failed_count = 0, locked_until = 0 WHERE id = ?').run(staff.id);
    startSession(ctx, 'staff', staff.id, STAFF_LIFETIME);
    audit({ ...ctx, staff }, 'staff.login', { target: `staff:${staff.id}` });
    return { ok: true, staff: { loginId: staff.login_id, name: staff.name, role: staff.role, roleLabel: ROLE_LABEL[staff.role] } };
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
  const staffView = (s) => ({ id: s.id, loginId: s.login_id, name: s.name, role: s.role, roleLabel: ROLE_LABEL[s.role], phone: s.phone, active: !!s.active });
  route('GET', '/api/staff/accounts', (ctx) => {
    needStaff(ctx, 'admin');
    return { staff: db.prepare('SELECT * FROM staff_accounts ORDER BY id').all().map(staffView) };
  });
  route('POST', '/api/staff/accounts', (ctx, body) => {
    needStaff(ctx, 'admin');
    const created = createStaff({ loginId: body.loginId, name: body.name, role: body.role, phone: body.phone });
    audit(ctx, 'staff.create', { target: `staff:${created.id}`, after: { loginId: created.loginId, role: created.role } });
    // 仮のパスワードと、認証アプリに登録する情報は、この1回だけ返す（あとからは見られない）
    return { ok: true, ...created };
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
  /** スタッフを作る。最初の主催者管理者は、tools/create-admin.js から呼ぶ */
  function createStaff({ loginId, name, role, phone }) {
    const id = String(loginId ?? '').trim();
    if (!/^[a-z0-9._-]{3,32}$/.test(id)) throw bad('ログイン ID は、半角の英小文字・数字・記号（. _ -）で 3〜32 文字にしてください');
    if (!ROLE_LABEL[role]) throw bad('役割を選んでください');
    const fullName = String(name ?? '').trim().slice(0, 100);
    if (!fullName) throw bad('名前を入力してください');
    const tel = phone ? normalizePhone(phone) : null;
    if (phone && !tel) throw bad('電話番号を、国内の番号で入力してください');
    if (tel && db.prepare('SELECT 1 FROM member_accounts WHERE phone = ?').get(tel)) throw new HttpError(409, 'この電話番号は、会員として登録されています');
    if (db.prepare('SELECT 1 FROM staff_accounts WHERE login_id = ?').get(id)) throw new HttpError(409, 'このログイン ID は使われています');
    const password = randomToken(12);
    const secret = newTotpSecret();
    const info = db.prepare('INSERT INTO staff_accounts (login_id, name, role, phone, password_hash, totp_secret, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, fullName, role, tel, hashPassword(password), secret, nowMs());
    return { id: Number(info.lastInsertRowid), loginId: id, role, initialPassword: password, totpSecret: secret, otpauthUrl: otpauthUrl(secret, id) };
  }

  // 会員の一覧・停止（主催者管理者だけ。FR-AUTH-009）
  route('GET', '/api/members', (ctx) => {
    needStaff(ctx, 'admin');
    return { members: db.prepare('SELECT * FROM member_accounts ORDER BY id DESC LIMIT 500').all().map((m) => ({ id: m.id, ...memberView(m), suspendReason: m.suspend_reason })) };
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
  // SMS の送信の制限を解く（会場で本人を確かめたうえで。FR-AUTH-004）
  route('POST', '/api/sms-limit/reset', (ctx, body) => {
    needStaff(ctx, 'admin', 'auctioneer', 'reception');
    const phone = phoneOf(body);
    db.prepare('DELETE FROM otp_sends WHERE phone = ?').run(phone);
    audit(ctx, 'sms.limit_reset', { target: `phone:${phone.slice(0, 3)}****${phone.slice(-2)}` });
    return { ok: true };
  });

  // ------------------------------------------------------------ 開催（FR-EVT-001・002。主催者管理者だけ）
  const eventView = (e) => ({ id: e.id, title: e.title, startsAt: e.starts_at, endsAt: e.ends_at, venueName: e.venue_name, venueAddress: e.venue_address, notified: !!e.notified, status: e.status });
  function eventInput(body) {
    const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
    const e = { title: text(body.title), startsAt: text(body.startsAt, 16), endsAt: text(body.endsAt, 16), venueName: text(body.venueName), venueAddress: text(body.venueAddress, 300), notified: body.notified === true ? 1 : 0 };
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
    const info = db.prepare('INSERT INTO events (title, starts_at, ends_at, venue_name, venue_address, notified, created_at) VALUES (?,?,?,?,?,?,?)').run(e.title, e.startsAt, e.endsAt, e.venueName, e.venueAddress, e.notified, nowMs());
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
    db.prepare('UPDATE events SET title=?, starts_at=?, ends_at=?, venue_name=?, venue_address=?, notified=?, status=? WHERE id=?').run(e.title, e.startsAt, e.endsAt, e.venueName, e.venueAddress, e.notified, status, id);
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
    return { ok: true };
  });

  // ------------------------------------------------------------ 参加手続き（FR-MODE-005、FR-SHIP-007、FR-PAY-009、FR-NUM-001）
  /** いまの開催: 公開中の開催のうち、開始がいちばん早いもの【前提】。開催終了（FR-EVT-003）は MVP の 5 で足す */
  const activeEvent = () => db.prepare("SELECT * FROM events WHERE status = 'published' ORDER BY starts_at, id LIMIT 1").get() ?? null;
  const participant = (accountId, eventId) => db.prepare('SELECT id, paddle_no, name, account_id, event_id, receive, payment FROM members WHERE account_id = ? AND event_id = ?').get(accountId, eventId) ?? null;
  const RECEIVE = { pickup: '現地受け取り', ship: '配送' };
  route('GET', '/api/participation', (ctx) => {
    const member = needMember(ctx);
    const event = activeEvent();
    const p = event ? participant(member.id, event.id) : null;
    return {
      event: event ? { title: event.title, venueName: event.venue_name } : null,
      joined: !!p, paddle: p?.paddle_no ?? null, receive: p?.receive ?? null, payment: p?.payment ?? null,
      suspended: !!member.suspended,
    };
  });
  route('POST', '/api/join', (ctx, body) => {
    const member = needMember(ctx);
    const event = activeEvent();
    if (!event) throw new HttpError(409, '開催中の競りはありません');
    const errors = {};
    if (!RECEIVE[body.receive]) errors.receive = '受け取り方法を選んでください';
    // オンライン参加の人は、銀行振込だけを選べる（FR-PAY-002）。当日現金は、会場参加（MVP の 4）で選べるようにする
    if (body.payment !== 'transfer') errors.payment = body.payment === 'cash' ? '当日現金は、会場で参加する方だけが選べます' : '支払方法を選んでください';
    if (Object.keys(errors).length) throw bad('受け取り方法と支払方法の両方に、お答えください', { errors });
    const existing = participant(member.id, event.id);
    if (existing) return { ok: true, paddle: existing.paddle_no };
    // 参加番号は、開催ごとに1から。番号を取るのと書き込むのを、1つの処理にまとめる（2人に同じ番号を振らない）
    const paddle = db.transaction(() => {
      const next = db.prepare('SELECT COALESCE(MAX(paddle_no), 0) + 1 AS n FROM members WHERE event_id = ?').get(event.id).n;
      db.prepare('INSERT INTO members (paddle_no, name, token_hash, account_id, event_id, receive, payment, mode, joined_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(next, member.name, sha256(randomToken()), member.id, event.id, body.receive, 'transfer', 'online', nowMs());
      return next;
    })();
    audit(ctx, 'event.join', { target: `event:${event.id}`, after: { paddle, receive: body.receive, payment: 'transfer', mode: 'online' } });
    return { ok: true, paddle };
  });
  /** 入札画面の接続（WebSocket）を、ログインのクッキーで確かめる。参加手続きが済んでいれば、その参加者を返す */
  function participantFromCookie(req) {
    const ctx = { req };
    loadSession(ctx);
    if (!ctx.member) return { code: 'LOGIN', message: 'ログインしてください' };
    const event = activeEvent();
    if (!event) return { code: 'NO_EVENT', message: '開催中の競りはありません' };
    const p = participant(ctx.member.id, event.id);
    if (!p) return { code: 'NOT_JOINED', message: '参加手続きを済ませてください' };
    return { member: p };
  }
  /** 入札してよいか。停止中の会員は SUSPENDED（FR-AUTH-009）。停止の前に受理された入札は、有効のまま */
  const suspendedStmt = db.prepare('SELECT suspended FROM member_accounts WHERE id = ?');
  const bidGate = (m) => {
    if (!m.account_id) return null; // 検証用の参加者（合言葉の URL）
    // つないだあとで開催が切り替わったら、前の開催の参加番号では入札できない（新しい開催で、参加手続きをやり直す）
    if (m.event_id !== (activeEvent()?.id ?? null)) return 'NOT_JOINED';
    return suspendedStmt.get(m.account_id)?.suspended ? 'SUSPENDED' : null;
  };

  // ------------------------------------------------------------ 表示する文言
  // 商品は、競りの最中に進行コンソールからその場で登録する（発注者の決定）。事前の登録・審査・カタログは持たない。
  // 送料が含まれないことの表示（FR-SHIP-003）と、返品特約の表示（FR-LEG-002）。だれでも見られる
  route('GET', '/api/terms', () => ({ orgName: setting('org_name'), shippingNotice: setting('shipping_notice'), returnPolicy: setting('return_policy') }));

  // ------------------------------------------------------------ 主催者設定（FR-ORG-001 の一部）・監査ログ・知らせ
  route('GET', '/api/settings', (ctx) => {
    needStaff(ctx, 'admin');
    return { orgName: setting('org_name'), returnPolicy: setting('return_policy'), shippingNotice: setting('shipping_notice') };
  });
  route('POST', '/api/settings', (ctx, body) => {
    needStaff(ctx, 'admin');
    const next = {
      org_name: String(body.orgName ?? '').trim().slice(0, 100),
      return_policy: String(body.returnPolicy ?? '').trim().slice(0, 2000),
      shipping_notice: String(body.shippingNotice ?? '').trim().slice(0, 1000),
    };
    if (!next.org_name || !next.return_policy || !next.shipping_notice) throw bad('名称・返品特約・送料の表示は、空にできません');
    const before = Object.fromEntries(Object.keys(next).map((k) => [k, setting(k)]));
    for (const [k, v] of Object.entries(next)) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
    audit(ctx, 'settings.update', { target: 'settings', before, after: next });
    return { ok: true };
  });
  route('GET', '/api/audit', (ctx) => {
    needStaff(ctx, 'admin');
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
    const ctx = { req, res, url, ip: req.socket.remoteAddress };
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
          if (host !== req.headers.host && !config.allowedOrigins.includes(origin)) throw new HttpError(403, 'このページからは操作できません');
        }
        const raw = await readBody(req, 64 * 1024);
        if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'JSON で送ってください');
        try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw bad('JSON として読めません'); }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('JSON のオブジェクトで送ってください');
      }
      const result = await hit.r.handler(ctx, body, ...hit.m.slice(1).map(Number));
      if (result?.redirect) { res.writeHead(302, { location: result.redirect }); return res.end(); }
      sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { ok: false, message: err.message, ...err.extra });
      console.error('[api]', err);
      sendJson(res, 500, { ok: false, message: 'サーバーで問題が起きました。時間をおいて、やり直してください' });
    }
  }

  return { handle, createStaff, audit, participantFromCookie, bidGate, eventId: () => activeEvent()?.id ?? null };
}
