// 開催・参加手続き・開催のお知らせメール（報告書 119 章で、api.js から分けた。中身は、分ける前と同じ）
import { DAY, HOUR, HttpError, ONSITE, PAY, bad } from './shared.js';
import { isEmail, randomToken, safeEqual, sha256 } from './security.js';
import { compose, jpDay, subjectOf } from './mails.js';

export function createEvents(deps) {
  const { audit, billing, config, db, nameOf, needMember, needStaff, notifier, nowMs, route, setting } = deps;
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
  // 公開の前に入れておく項目のうち、まだ入っていないもの
  function setupLacking() {
    return [
      !setting('legal_terms') && '利用規約', !setting('legal_privacy') && 'プライバシーポリシー', !setting('legal_tokushoho') && '特定商取引法に基づく表示',
      /【仮/.test(setting('return_policy')) && '返品特約（仮の文言のまま）', !setting('bank_account') && '振込先', !setting('kobutsu_license') && '古物商の許可の表示',
    ].filter(Boolean);
  }
  route('POST', '/api/events/:id/publish', (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const e = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    if (!e) throw new HttpError(404, '開催が見つかりません');
    if (!e.notified) throw new HttpError(409, '公安委員会への届出済みの印がない開催は、公開できません');
    // 本番の設定では、会員に見せる・請求書に載せる項目がそろうまで、公開できない（規約が「準備中」のまま、振込先が無いまま、開催しないように）
    if (config.requireSetup) {
      const lacking = setupLacking();
      if (lacking.length) throw new HttpError(409, `公開の前に、次の項目を入れてください: ${lacking.join('、')}（管理の「設定」）`, { lacking });
    }
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
        // 送る前に記録する（途中で止まっても、同じ人に二重に送らない）
        const fresh = db.prepare('INSERT OR IGNORE INTO event_mails (event_id, account_id, at) VALUES (?, ?, ?)').run(e.id, a.id, nowMs());
        if (!fresh.changes || !isEmail(a.email)) continue;
        const ok = await notifier.email(a.email, 'event', subject, eventMailText(e, a, when));
        // 送れなかったとき（再送3回のあと）は、記録を消して、次の見回りで、もう一度送る。同じ人に、3回の見回りまで（それでも送れなければ、あきらめる。失敗は、知らせに残る）
        if (!ok) {
          db.prepare('INSERT INTO event_mail_fails (event_id, account_id, n) VALUES (?, ?, 1) ON CONFLICT(event_id, account_id) DO UPDATE SET n = n + 1').run(e.id, a.id);
          if (db.prepare('SELECT n FROM event_mail_fails WHERE event_id = ? AND account_id = ?').get(e.id, a.id).n < 3) db.prepare('DELETE FROM event_mails WHERE event_id = ? AND account_id = ?').run(e.id, a.id);
          continue;
        }
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
  const PAYMENT = PAY;
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
  // 当日現金・当日クレジットを選んでいた場合は、銀行振込にする（すでに会場で精算した分は、そのまま）
  route('POST', '/api/my/participation/online', (ctx) => {
    const member = needMember(ctx);
    const event = activeEvent();
    const p = event ? participant(member.id, event.id) : null;
    if (!p) throw new HttpError(409, '参加手続きが済んでいません');
    if (p.mode !== 'venue') return { ok: true, paddle: p.paddle_no, mode: p.mode, checkedIn: true, payment: p.payment };
    const payment = ONSITE.includes(p.payment) ? 'transfer' : p.payment;
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
    if (p.mode === 'online' && ONSITE.includes(next.payment)) throw bad(`${PAY[next.payment]}は、会場で参加する方だけが選べます`);
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
    // オンライン参加の人は、銀行振込だけを選べる。会場参加の人は、当日現金・当日クレジット・銀行振込のどれも選べる（FR-PAY-002。報告書 133 章）
    if (!Object.hasOwn(PAYMENT, body.payment)) errors.payment = '支払方法を選んでください';
    else if (mode === 'online' && ONSITE.includes(body.payment)) errors.payment = `${PAY[body.payment]}は、会場で参加する方だけが選べます`;
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
  const endedToday = () => !activeEvent() && !!db.prepare("SELECT 1 FROM events WHERE status = 'published' AND substr(starts_at, 1, 10) = ? AND phase = 'ended'").get(todayJst());
  return { PAYMENT, RECEIVE, activeEvent, alertAdmins, endedToday, hooks, participant, sendEventMails };
}
