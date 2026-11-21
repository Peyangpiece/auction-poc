// 未払い: 督促・解除・繰り上げ・違約金・返金（報告書 119 章で、billing.js から分けた。中身は、分ける前と同じ）
import { DAY, addDays } from './shared.js';
import { compose, jpDay, kv, subjectOf } from './mails.js';

export function createUnpaid(deps) {
  const { HttpError, account, audit, bad, db, displayName, getLine, issueInvoice, jst, lineView, needStaff, notifier, nowMs, payable, premiumOf, premiumRate, route, setting, suspension, text, today, yen } = deps;
  // ------------------------------------------------------------ 未払い: 督促・解除・違約金・繰り上げ・返金（FR-PAY-005〜007・012、FR-PEN-002）
  const isUnpaid = (l) => lineView(l).state === 'unpaid';
  route('POST', '/api/billing/lines/:id/dun', (ctx, body, id) => {
    const me = needStaff(ctx, 'admin');
    getLine(id);
    const method = text(body.method, 50), note = text(body.body, 1000);
    if (!method || !note) throw bad('督促の方法と内容を入力してください');
    db.prepare('INSERT INTO dunning (line_id, at, method, body, staff_id) VALUES (?,?,?,?,?)').run(id, nowMs(), method, note, me.id);
    audit(ctx, 'billing.dun', { target: `line:${id}`, after: { method } });
    return { ok: true };
  });
  route('POST', '/api/billing/lines/:id/cancel', (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const l = getLine(id);
    const reason = text(body.reason);
    if (!reason) throw bad('解除の理由を入力してください');
    if (!isUnpaid(l)) throw new HttpError(409, '解除できるのは、支払期限を過ぎて消し込まれていない（未払いの）明細だけです');
    db.prepare('UPDATE bill_lines SET cancelled_at = ?, cancel_reason = ? WHERE id = ?').run(nowMs(), reason, id);
    const a = account(l.account_id);
    notifier.email(a.email, 'cancelled', subjectOf(`落札を解除しました　${l.label}`), compose(setting, { name: displayName(a), lines: [
      `${l.label}（落札額 ${yen(l.amount)}）は、お支払いの確認が取れなかったため、落札を解除しました。`,
      '',
      ...kv([['理由', reason]]),
      '',
      'お支払い済みの場合や、お心当たりがない場合は、このメールにご返信ください。',
    ] }));
    audit(ctx, 'billing.cancel', { target: `line:${id}`, before: { cancelled: false }, after: { cancelled: true }, reason });
    return { ok: true };
  });
  // 違約金・遅延損害金の請求（金額は、主催者管理者が確かめて確定する。設定の値は未決。OQ-04b）
  route('POST', '/api/billing/lines/:id/penalty', async (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const l = getLine(id);
    const kind = body.kind === 'late' ? 'late' : 'penalty';
    const amount = Number(body.amount);
    if (!Number.isSafeInteger(amount) || amount < 1) throw bad('金額を、1円以上の整数で入力してください');
    if (kind === 'penalty' && !l.cancelled_at) throw new HttpError(409, '違約金は、解除した明細について請求します');
    if (kind === 'late' && !(l.cleared_at || l.cancelled_at)) throw new HttpError(409, '遅延損害金は、入金（または解除）のあとに請求します');
    // 同じ明細には、違約金・遅延損害金をそれぞれ1回まで。違約金・遅延損害金の明細には、さらにかけない（本番運用の評価 C）
    if (l.kind === 'penalty' || l.kind === 'late') throw new HttpError(409, '違約金・遅延損害金の明細には、かけられません');
    if (db.prepare('SELECT 1 FROM bill_lines WHERE parent_line_id = ? AND kind = ?').get(l.id, kind)) throw new HttpError(409, `この明細には、すでに${kind === 'late' ? '遅延損害金' : '違約金'}を請求しています`);
    if (kind === 'late') {
      const inv = l.invoice_id ? db.prepare('SELECT due_date FROM invoices WHERE id = ?').get(l.invoice_id) : null;
      const paidOn = l.cleared_at ? jst(l.cleared_at) : today();
      if (!inv?.due_date || paidOn <= inv.due_date) throw new HttpError(409, '支払期限までに払われた明細には、遅延損害金をかけられません');
    }
    const r = db.prepare('INSERT INTO bill_lines (kind, event_id, lot_id, participant_id, account_id, label, amount, parent_line_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(kind, l.event_id, l.lot_id, l.participant_id, l.account_id, `${kind === 'late' ? '遅延損害金' : '違約金'}（${l.label}）`, amount, l.id, nowMs());
    // 支払期限は、送付日の翌日から数えて7日目。休業日でも前に繰り上げない（FR-PEN-002）
    const inv = issueInvoice('penalty', [Number(r.lastInsertRowid)], { dueDays: 7, draft: true });
    await inv.done;
    audit(ctx, 'billing.penalty', { target: `line:${id}`, after: { kind, amount, invoice: inv.number } });
    return { ok: true, invoice: inv.number };
  });
  // 違約金・遅延損害金の金額の案（FR-PEN-001・002）。主催者設定の率から計算した値を示し、主催者管理者が確かめて確定する
  route('GET', '/api/billing/lines/:id/penalty-suggest', (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const l = getLine(id);
    const a = account(l.account_id);
    const kind = ctx.url.searchParams.get('kind') === 'late' ? 'late' : 'penalty';
    const rate = Number(setting(`${kind}_rate_${a.kind}`)); // 法人と個人で、別の率を持つ
    if (!(rate > 0)) return { amount: null, basis: '率が設定されていないため、金額を手で入力してください' };
    if (kind === 'penalty') return { amount: Math.floor(l.amount * rate / 100), basis: `落札額 ${yen(l.amount)} × ${rate}%` };
    // 遅延損害金: 支払期限の翌日から、消し込みの日（または解除の日。どちらもまだなら今日）までの日数で日割りし、1円未満は切り捨てる
    const inv = l.invoice_id ? db.prepare('SELECT due_date FROM invoices WHERE id = ?').get(l.invoice_id) : null;
    if (!inv?.due_date) return { amount: null, basis: '支払期限が決まっていない（未送付の）請求です' };
    const end = l.cleared_at ? jst(l.cleared_at) : l.cancelled_at ? jst(l.cancelled_at) : today();
    const days = Math.max(0, Math.round((Date.parse(end) - Date.parse(inv.due_date)) / DAY));
    return { amount: Math.floor(payable(l) * rate / 100 * days / 365), days, basis: `${yen(payable(l))} × 年${rate}% × ${days}日 ÷ 365` };
  });
  /** 次点: 落札者を除いた参加者のうち、その品で最も高い有効な入札をした人。停止中の会員は除く（FR-PAY-007） */
  function runnerUp(l) {
    const rows = db.prepare(`SELECT b.amount, m.id AS participant_id, m.account_id FROM bids b JOIN members m ON m.id = b.member_id
      JOIN member_accounts a ON a.id = m.account_id
      WHERE b.lot_id = ? AND b.result = 'ACCEPTED' AND b.valid = 1 AND m.account_id IS NOT NULL AND m.account_id <> ? AND a.withdrawn_at IS NULL ORDER BY b.amount DESC, b.seq DESC`).all(l.lot_id, l.account_id); // 退会した人には打診しない（本番運用の評価 B5）
    const top = rows[0];
    if (!top) return null;
    return suspension(top.account_id) ? { ...top, blocked: true } : top;
  }
  route('POST', '/api/billing/lines/:id/offer', (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const l = getLine(id);
    if (l.kind !== 'lot' || !l.cancelled_at) throw new HttpError(409, '繰り上げを打診できるのは、解除した落札の明細だけです');
    if (db.prepare('SELECT 1 FROM offers WHERE line_id = ?').get(id)) throw new HttpError(409, 'この明細は、すでに次点の人に打診しています（打診するのは1人だけです）');
    const next = runnerUp(l);
    if (!next) throw new HttpError(409, '次点の人がいません');
    if (next.blocked) throw new HttpError(409, '次点の人は参加を停止されているため、打診できません');
    // 回答期限: 打診した日の翌日から数えて3日目まで。価格は、次点の人がその品で最後に入れた有効な入札額
    const deadline = addDays(today(), 3);
    const offerPremium = premiumOf(next.amount);
    db.prepare('INSERT INTO offers (line_id, participant_id, account_id, amount, premium, offered_at, deadline) VALUES (?,?,?,?,?,?,?)').run(id, next.participant_id, next.account_id, next.amount, offerPremium, nowMs(), deadline);
    const a = account(next.account_id);
    notifier.email(a.email, 'offer', subjectOf(`繰り上げ落札のご案内（${jpDay(deadline)}までにご回答ください）`), compose(setting, { name: displayName(a), lines: [
      `${l.label} の落札が解除されたため、次点のお客様に、繰り上げて落札いただけるかをお尋ねします。`,
      '',
      ...kv([
        ['価格', `${yen(next.amount)}（税込。あなたが最後に入れた入札額です）`],
        ['買歩銭', `${yen(offerPremium)}（落札額の${premiumRate()}%）`],
        ['お支払いの金額', yen(next.amount + offerPremium)],
        ['ご回答の期限', `${jpDay(deadline)}まで`],
      ]),
      '',
      'マイページで、「承諾」か「辞退」をお選びください。承諾いただくと、請求書をお送りします。',
      '期限までにご回答がない場合は、辞退とさせていただきます。',
    ] }));
    audit(ctx, 'billing.offer', { target: `line:${id}`, after: { amount: next.amount, deadline } });
    return { ok: true, amount: next.amount, deadline };
  });
  route('POST', '/api/billing/lines/:id/refund', (ctx, body, id) => {
    const me = needStaff(ctx, 'admin');
    const l = getLine(id);
    const amount = Number(body.amount), on = text(body.date, 10), method = ['cash', 'transfer', 'card'].includes(body.method) ? body.method : null, reason = text(body.reason);
    if (!Number.isSafeInteger(amount) || amount < 1) throw bad('返金額を、1円以上の整数で入力してください');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) throw bad('返金日を入力してください');
    if (!method) throw bad('返金の方法（現金・振込・クレジット）を選んでください');
    if (!reason) throw bad('返金の理由を入力してください');
    // 返金日は、未来の日にしない。手数料を確認済みにした月にもしない（確認済みの金額が、あとから変わらないように。本番運用の評価 B1）
    if (on > today()) throw bad('返金日に、未来の日は入れられません');
    if (db.prepare('SELECT 1 FROM fee_confirms WHERE month = ?').get(on.slice(0, 7))) throw new HttpError(409, `${on.slice(0, 7)} の手数料は確認済みです。返金日は、確認していない月の日にしてください`);
    // 返金の合計は、払う金額（落札額＋買歩銭）まで
    const before = db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM refunds WHERE line_id = ?').get(id).n;
    if (before + amount > payable(l)) throw bad(`返金の合計が、払う金額（${payable(l).toLocaleString('ja-JP')}円）を超えます。これまでの返金は ${before.toLocaleString('ja-JP')}円です`);
    db.prepare('INSERT INTO refunds (line_id, amount, refunded_on, method, reason, staff_id, at) VALUES (?,?,?,?,?,?,?)').run(id, amount, on, method, reason, me.id, nowMs());
    audit(ctx, 'billing.refund', { target: `line:${id}`, after: { amount, date: on, method }, reason });
    return { ok: true, lineAmount: l.amount };
  });
  return {  };
}
