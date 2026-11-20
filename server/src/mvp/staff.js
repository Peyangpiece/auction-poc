// スタッフ（登録・ログイン・二段階認証・パスワード）（報告書 119 章で、api.js から分けた。中身は、分ける前と同じ）
import QRCode from 'qrcode';
import { DAY, HOUR, HttpError, LOCK_AFTER, STAFF_FAIL_GLOBAL, LOCK_FOR, MIN, ROLE_LABEL, STAFF_LIFETIME, bad, siteOrigin, requestOrigin } from './shared.js';
import { hashPassword, isEmail, newTotpSecret, normalizePhone, otpauthUrl, randomToken, safeEqual, sha256, verifyPassword, verifyPasswordAsync } from './security.js';
import { compose, jpDay, subjectOf } from './mails.js';

export function createStaffApi(deps) {
  const { audit, config, db, loginGuard, dropLogin, healthDetail, memberView, nameOf, needStaff, newPassword, notifier, nowMs, route, setting, startSession, throttle, trustDevice, trustedDevice } = deps;
  // ------------------------------------------------------------ スタッフ
  // スタッフのログイン: メールアドレスとパスワード（発注者の指示。認証アプリのコードは、使わなくなった）。
  // メールアドレスを登録していない、前からのアカウントは、ログイン ID でも入れる
  const staffByLogin = (raw) => {
    const id = String(raw ?? '').trim().toLowerCase();
    return (id.includes('@') ? db.prepare('SELECT * FROM staff_accounts WHERE lower(email) = ?').get(id) : db.prepare('SELECT * FROM staff_accounts WHERE login_id = ?').get(id)) ?? null;
  };
  // 止めは2つ（会員と同じ。報告書 121 章）: この接続元からの誤り5回（この接続元だけを止める）と、接続元をまたいだ誤り25回（全体を止める）
  const staffFailed = (ctx, staff, now, guard) => {
    const pair = guard.failed(now);
    const failed = db.prepare('UPDATE staff_accounts SET failed_count = failed_count + 1 WHERE id = ? RETURNING failed_count').get(staff.id)?.failed_count ?? 0;
    const lock = failed >= STAFF_FAIL_GLOBAL;
    if (lock) db.prepare('UPDATE staff_accounts SET failed_count = 0, locked_until = ? WHERE id = ?').run(now + LOCK_FOR, staff.id);
    if (lock || pair) audit({ ...ctx, system: true }, 'staff.locked', { target: `staff:${staff.id}`, after: { scope: lock ? 'all' : 'ip' } });
  };
  const staffOut = (staff) => ({ loginId: staff.login_id, email: staff.email ?? null, name: staff.name, role: staff.role, roleLabel: ROLE_LABEL[staff.role] });
  route('POST', '/api/staff/login', async (ctx, body) => {
    throttle(ctx);
    const staff = staffByLogin(body.email ?? body.loginId);
    // どれが違ったか（登録の有無・パスワードが未登録か）は、伝えない
    const fail = new HttpError(401, 'メールアドレスかパスワードが違います。はじめてログインする方は、下の「はじめての方」からお進みください');
    if (!staff || !staff.active) throw fail;
    const now = nowMs();
    const trusted = trustedDevice(ctx, 's', staff.id); // いつもの端末には、ロックを掛けない（締め出しを防ぐ）
    const locked = (until) => new HttpError(423, `誤りが続いたため、ロックしています。${Math.ceil((until - now) / MIN)} 分後にやり直してください`);
    const guard = loginGuard('s', staff, ctx, { max: LOCK_AFTER, lockMs: LOCK_FOR });
    const until = Math.max(staff.locked_until > now ? staff.locked_until : 0, guard.lockedUntil(now));
    if (until && !trusted) throw locked(until);
    if (!staff.password_hash || !(await verifyPasswordAsync(body.password ?? '', staff.password_hash))) {
      if (staff.password_hash && !trusted) staffFailed(ctx, staff, now, guard);
      throw fail;
    }
    // 照合のあいだに、止められた・パスワードが変わったかもしれないので、読み直す
    const fresh = db.prepare('SELECT active, password_hash, locked_until FROM staff_accounts WHERE id = ?').get(staff.id);
    if (!fresh?.active || fresh.password_hash !== staff.password_hash) throw fail;
    if (!trusted && (fresh.locked_until > now || guard.lockedUntil(now))) throw locked(Math.max(fresh.locked_until, guard.lockedUntil(now)));
    guard.passed();
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
  // 保存と、書き込みの控えの、細かい状態（主催者管理者だけ）
  route('GET', '/api/staff/health', (ctx) => { needStaff(ctx, 'admin'); return { ok: true, ...healthDetail() }; });
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
  const setupMailAt = new Map(), setupMailDay = new Map();
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
    // 主催者管理者が送ったリンクが、まだ新しい（1時間以内）うちは、作り直さない（他人が、この入口を呼んで、届いたばかりのリンクを使えなくするのを防ぐ）。
    // 同じ宛先に送るのは、1日に3通まで
    const issuedAt = staff.setup_hash ? staff.setup_expires - SETUP_LIFETIME : 0;
    if (issuedAt && nowMs() - issuedAt < HOUR) return same;
    const day = setupMailDay.get(mail)?.filter((t) => nowMs() - t < DAY) ?? [];
    if (day.length >= 3) return same;
    setupMailDay.set(mail, [...day, nowMs()]);
    if (setupMailAt.size > 5000) setupMailAt.clear();
    if (setupMailDay.size > 5000) setupMailDay.clear();
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
    trustDevice(ctx, 's', me.id);
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
  function inviteStaff({ email, name, role, phone = undefined }) {
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
    // ログインしていない人の要求（「はじめての方」）では、要求のヘッダー（Host）を、リンクの先に使わない。
    // 入口（プロキシ）が付けた値だけを信用する。どれも無ければ、送らない（偽のサイトへのリンクを、本人あてに送らせないため）
    const trusted = config.siteUrl || setting('site_url') || (config.trustProxy && ctx.req.headers['x-forwarded-host'] ? `https://${ctx.req.headers['x-forwarded-host']}` : '');
    if (!ctx.staff && !trusted && !config.devShowCodes) { console.error('[staff] サイトの URL が決まっていないので、設定用のメールを送りません（POC_SITE_URL を入れてください）'); return {}; }
    const origin = trusted || requestOrigin(config, ctx.req);
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
  function createStaff({ loginId, name, role, phone = undefined, password: given = undefined }) {
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
    const origin = siteOrigin(config, ctx.req);
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
  return { createStaff, inviteStaff };
}
