// 受付（来場確認・入札できるかどうかの判定）（報告書 119 章で、api.js から分けた。中身は、分ける前と同じ）
import QRCode from 'qrcode';
import { HttpError, bad, siteOrigin } from './shared.js';
import { randomToken, sha256 } from './security.js';

export function createReception(deps) {
  const { PAYMENT, RECEIVE, activeEvent, audit, billing, config, db, loadSession, needMember, needStaff, nowMs, participant, phoneOf, route } = deps;
  // ------------------------------------------------------------ 受付（来場確認。FR-MODE-002・004。主催者管理者・進行役・受付係）
  const venueUrl = (ctx, event) => `${siteOrigin(config, ctx.req)}/bidder.html?venue=${event.venue_code}`;
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
  return { bidGate, participantFromCookie };
}
