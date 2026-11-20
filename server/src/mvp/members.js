// 会員（登録・ログイン・登録内容の変更・退会・主催者管理者による管理）（報告書 119 章で、api.js から分けた。中身は、分ける前と同じ）
import { HttpError, LOGIN_FAIL_MAX, LOGIN_LOCK, MEMBER_IDLE, MIN, REGISTER_LIFETIME, ROLE_LABEL, bad } from './shared.js';
import { hashPassword, isEmail, normalizePhone, sha256, verifyPassword } from './security.js';

export function createMembers(deps) {
  const { audit, checkOtp, config, credentialErrors, db, dropLogin, endSession, loginTarget, lookupPostal, memberView, needMember, needStaff, normLoginId, nowMs, passwordMatches, persistStatus, personFrom, phoneOf, registerKey, route, sendEmailVerification, sendOtp, startSession, throttle, toHalfDigits, trustDevice, trustedDevice } = deps;
  // ------------------------------------------------------------ 会員の受け口
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
    trustDevice(ctx, 'm', m.id); // この端末の印を、新しいパスワードで作り直す（ほかの端末の印は、使えなくなる）
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
  return {  };
}
