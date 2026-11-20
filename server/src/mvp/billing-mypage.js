// 会員のマイページの、落札・請求・繰り上げの受け口（報告書 119 章で、billing.js から分けた。中身は、分ける前と同じ）
import { addDays } from './shared.js';

export function createBillingMypage(deps) {
  const { HttpError, audit, bad, db, getLine, invoiceAmounts, issueInvoice, jst, lineView, needMember, nowMs, offerPremiumOf, payable, route, setting, suspension, syncLines, today } = deps;
  // ------------------------------------------------------------ 会員のマイページ（FR-INV-001、FR-PAY-008・009、FR-SHIP-008）
  route('GET', '/api/my/billing', (ctx) => {
    const me = needMember(ctx);
    syncLines();
    expireOffers();
    const offers = db.prepare("SELECT o.id, o.amount, o.premium, o.deadline, o.state, l.label FROM offers o JOIN bill_lines l ON l.id = o.line_id WHERE o.account_id = ? ORDER BY o.id DESC").all(me.id);
    return {
      suspension: suspension(me.id),
      // 振込先（マイページの請求書に出す。請求書の PDF と同じ値。本番運用の評価 C）
      bank: setting('bank_account') || null,
      lines: db.prepare('SELECT * FROM bill_lines WHERE account_id = ? ORDER BY id DESC').all(me.id).map(lineView),
      // 繰り上げのご案内: 払う金額（買歩銭込み）も返す。承諾の前に、画面で確かめてもらうため
      offers: offers.map((o) => ({ ...o, premium: offerPremiumOf(o), payable: o.amount + offerPremiumOf(o) })),
      // 請求書の一覧（マイページの「請求書」）。状態: paid（すべて消し込み済み）/ overdue（期限を過ぎている）/ billed（お支払い前）
      invoices: db.prepare('SELECT * FROM invoices WHERE account_id = ? ORDER BY id DESC').all(me.id).map((i) => {
        const open = db.prepare('SELECT COUNT(*) AS n FROM bill_lines WHERE invoice_id = ? AND cleared_at IS NULL AND cancelled_at IS NULL').get(i.id).n;
        const m = invoiceAmounts(i);
        // すべての明細を解除した請求書は「解除」（「お支払い済み」と出さない）。金額は、解除した明細を除いたもの
        return { id: i.id, number: i.number, kind: i.kind, issuedOn: jst(i.issued_at), total: m.due, issuedTotal: i.total, dueDate: i.due_date,
          // 明細が1つも残っていない請求書（当日現金の精算を、すべて取り消したもの）は「取り消し」。「お支払い済み」とは出さない
          state: m.lines === 0 ? 'void' : m.cancelled === m.lines ? 'cancelled' : open === 0 ? 'paid' : i.sent_at && i.due_date && i.due_date < today() ? 'overdue' : 'billed' };
      }),
    };
  });
  // その日に、何をいくらで落札したかの一覧（開催が終わったあと、トップページに出す）。
  // いちばん最近に終わった開催（7日以内）で、自分が落札した品。解除された落札は出さない
  route('GET', '/api/my/wins', (ctx) => {
    const me = needMember(ctx);
    syncLines();
    const ev = db.prepare(`SELECT e.id, e.title, e.starts_at FROM events e WHERE e.phase = 'ended' AND substr(e.starts_at, 1, 10) >= ?
      AND EXISTS (SELECT 1 FROM bill_lines l WHERE l.event_id = e.id AND l.account_id = ? AND l.kind = 'lot' AND l.cancelled_at IS NULL)
      ORDER BY e.starts_at DESC, e.id DESC LIMIT 1`).get(addDays(today(), -7), me.id);
    if (!ev) return { event: null, lines: [], total: null };
    const rows = db.prepare("SELECT * FROM bill_lines WHERE event_id = ? AND account_id = ? AND kind = 'lot' AND cancelled_at IS NULL ORDER BY id").all(ev.id, me.id);
    const sum = (f) => rows.reduce((n, l) => n + f(l), 0);
    return {
      event: { title: ev.title, date: ev.starts_at.slice(0, 10) },
      lines: rows.map((l) => ({ label: l.label, amount: l.amount, premium: l.premium ?? 0, payable: payable(l) })),
      total: { amount: sum((l) => l.amount), premium: sum((l) => l.premium ?? 0), payable: sum(payable) },
    };
  });
  route('POST', '/api/my/offers/:id', async (ctx, body, id) => {
    const me = needMember(ctx);
    expireOffers();
    const o = db.prepare('SELECT * FROM offers WHERE id = ? AND account_id = ?').get(id, me.id);
    if (!o) throw new HttpError(404, '繰り上げのご案内が見つかりません');
    if (o.state !== 'open') throw new HttpError(409, 'このご案内は、すでに回答済みか、期限が切れています');
    if (body.answer !== 'accept' && body.answer !== 'decline') throw bad('承諾か辞退かを選んでください');
    if (body.answer === 'decline') {
      db.prepare("UPDATE offers SET state = 'declined', answered_at = ? WHERE id = ?").run(nowMs(), id);
      audit(ctx, 'offer.decline', { target: `offer:${id}` });
      return { ok: true };
    }
    // 承諾: 繰り上げの請求書を、別に1通発行する。受け取り方法は、その人がその開催で選んだもの
    const src = getLine(o.line_id);
    const p = db.prepare('SELECT receive FROM members WHERE id = ?').get(o.participant_id);
    const r = db.prepare("INSERT INTO bill_lines (kind, event_id, lot_id, participant_id, account_id, label, amount, premium, receive, parent_line_id, created_at) VALUES ('promote',?,?,?,?,?,?,?,?,?,?)")
      .run(src.event_id, src.lot_id, o.participant_id, o.account_id, `${src.label}（繰り上げ）`, o.amount, offerPremiumOf(o), p?.receive ?? null, src.id, nowMs());
    db.prepare("UPDATE offers SET state = 'accepted', answered_at = ?, new_line_id = ? WHERE id = ?").run(nowMs(), r.lastInsertRowid, id);
    const inv = issueInvoice('promote', [Number(r.lastInsertRowid)], { dueDays: 5, draft: true });
    await inv.done;
    audit(ctx, 'offer.accept', { target: `offer:${id}`, after: { invoice: inv.number, amount: o.amount } });
    return { ok: true, invoice: inv.number };
  });
  // 回答期限までに回答がなければ、辞退とみなす
  function expireOffers() {
    db.prepare("UPDATE offers SET state = 'expired' WHERE state = 'open' AND deadline < ?").run(today());
  }
  return { expireOffers };
}
