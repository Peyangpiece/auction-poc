// 当日現金の精算・振込の消し込み・引き渡し（報告書 119 章で、billing.js から分けた。中身は、分ける前と同じ）
import { RECV } from './shared.js';

export function createClearing(deps) {
  const { HttpError, audit, bad, db, getLine, issueInvoice, needStaff, nowMs, payable, route, syncLines, text, today, yen } = deps;
  // ------------------------------------------------------------ 当日現金の精算（FR-PAY-010。受付係・主催者管理者）
  route('POST', '/api/billing/settle', async (ctx, body) => {
    const me = needStaff(ctx, 'admin', 'reception');
    syncLines();
    const ids = [...new Set((Array.isArray(body.lineIds) ? body.lineIds : []).map(Number))];
    if (!ids.length) throw bad('精算する明細を選んでください');
    const lines = ids.map(getLine);
    if (new Set(lines.map((l) => l.account_id)).size !== 1) throw bad('1回の精算は、1人の落札者の明細だけにしてください');
    for (const l of lines) {
      if (l.kind !== 'lot' || l.invoice_id || l.cleared_at || l.cancelled_at) throw new HttpError(409, `${l.label} は、当日現金では精算できません（請求済み、または精算済みです）`);
    }
    const now = nowMs();
    db.transaction(() => {
      for (const l of lines) {
        db.prepare("UPDATE bill_lines SET cleared_at = ?, cleared_method = 'cash', cleared_by = ? WHERE id = ?").run(now, me.id, l.id);
        db.prepare("INSERT INTO clearings (line_id, amount, method, cleared_at) VALUES (?,?,'cash',?)").run(l.id, l.amount, now);
      }
    })();
    // 精算した明細だけを載せた請求書（領収書を兼ねる）を発行する。その場で渡すので、メールの下書きは作らない
    const inv = issueInvoice('cash', ids);
    await inv.done;
    audit(ctx, 'billing.settle', { target: `invoice:${inv.number}`, after: { lines: ids, total: inv.total, method: 'cash' } });
    return { ok: true, invoice: { id: inv.id, number: inv.number, total: inv.total } };
  });

  // ------------------------------------------------------------ 振込の消し込みと、その取り消し（FR-PAY-001・011。主催者管理者だけ）
  route('POST', '/api/billing/lines/:id/clear', (ctx, body, id) => {
    // 現金の受け取り（開催終了のあとに会場・事務所で受け取った現金）は、受付係もできる。振込は主催者管理者だけ（本番運用の評価 C）
    const method = body.method === 'cash' ? 'cash' : 'transfer';
    const me = method === 'cash' ? needStaff(ctx, 'admin', 'reception') : needStaff(ctx, 'admin');
    const l = getLine(id);
    // 入金の日（既定は今日）。期限・停止・受け取りの期限・手数料の月は、この日で数える（操作した日ではなく。本番運用の評価 C）
    const paidOn = body.paidOn ? text(body.paidOn, 10) : today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) throw bad('入金の日を、正しく入力してください');
    if (paidOn > today()) throw bad('入金の日に、未来の日は入れられません');
    if (db.prepare('SELECT 1 FROM fee_confirms WHERE month = ?').get(paidOn.slice(0, 7))) throw new HttpError(409, `${paidOn.slice(0, 7)} の手数料は確認済みです。入金の日は、確認していない月の日にしてください`);
    if (l.cancelled_at) throw new HttpError(409, '解除した明細は、消し込めません。入金があった場合は、返金として記録してください'); // AC-FR-PAY-006-1
    if (l.cleared_at) throw new HttpError(409, 'この明細は、消し込み済みです');
    if (!l.invoice_id) throw new HttpError(409, 'まだ請求書を発行していない明細です。当日現金は「精算」で、振込は開催終了の後に消し込みます');
    // 明細の金額と入金の金額が一致するときだけ、消し込める（一部だけ・多すぎる入金の扱いは未決。OQ-26）
    if (Number(body.amount) !== payable(l)) throw bad(`入金の金額が、明細の金額（${yen(payable(l))}）と一致しません。一致しない入金は、システムの外で対応し、理由をメモに残してください`);
    // 入金の日の正午（日本時間）を、消し込みの時刻として持つ。今日なら、いまの時刻
    const at = paidOn === today() ? nowMs() : Date.parse(`${paidOn}T03:00:00Z`);
    db.transaction(() => {
      db.prepare('UPDATE bill_lines SET cleared_at = ?, cleared_method = ?, cleared_by = ?, clear_memo = ? WHERE id = ?').run(at, method, me.id, text(body.memo) || null, id);
      db.prepare('INSERT INTO clearings (line_id, amount, method, cleared_at) VALUES (?,?,?,?)').run(id, l.amount, method, at);
    })();
    audit(ctx, 'billing.clear', { target: `line:${id}`, before: { cleared: false }, after: { cleared: true, amount: payable(l), method, paidOn } });
    return { ok: true };
  });
  route('POST', '/api/billing/lines/:id/unclear', async (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const l = getLine(id);
    const reason = text(body.reason);
    if (!reason) throw bad('取り消しの理由を入力してください');
    if (!l.cleared_at) throw new HttpError(409, 'この明細は、消し込まれていません');
    if (l.delivered_at) throw new HttpError(409, '引き渡し済みの明細は、消し込みを取り消せません。先に、引き渡しの記録を取り消してください');
    // 当日現金の精算を取り消したら、その明細を、精算の請求書から外して「未精算」に戻す（そのままでは、どの請求書にも出ず、請求が漏れていた。
    // 本番運用の評価 B4）。開催終了の前なら、もう一度精算でき、開催終了のときは振込の請求書に入る。精算の請求書（領収書）は、記録として残す
    const cashInv = l.invoice_id ? db.prepare("SELECT id FROM invoices WHERE id = ? AND kind = 'cash'").get(l.invoice_id) : null;
    db.transaction(() => {
      if (cashInv) db.prepare('UPDATE bill_lines SET invoice_id = NULL WHERE id = ?').run(id);
      db.prepare('UPDATE bill_lines SET cleared_at = NULL, cleared_method = NULL, cleared_by = NULL WHERE id = ?').run(id);
      db.prepare('UPDATE clearings SET reversed_at = ?, reverse_reason = ? WHERE line_id = ? AND reversed_at IS NULL').run(nowMs(), reason, id);
    })();
    audit(ctx, 'billing.unclear', { target: `line:${id}`, before: { cleared: true }, after: { cleared: false }, reason });
    // 開催が終わったあとに、当日現金の精算を取り消した: その明細を、振込の請求書にする（そのままだと、請求する手段が無く、期限も停止も付かなかった）
    let reissued = null;
    if (cashInv && db.prepare("SELECT 1 FROM events WHERE id = ? AND phase = 'ended'").get(l.event_id)) {
      const inv = issueInvoice('transfer', [Number(id)], { dueDays: 5, draft: true });
      await inv.done;
      reissued = inv.number;
      audit(ctx, 'invoice.issue_after_unclear', { target: `invoice:${inv.number}`, after: { line: Number(id) } });
    }
    return { ok: true, reissued };
  });
  route('POST', '/api/billing/lines/:id/memo', (ctx, body, id) => {
    needStaff(ctx, 'admin');
    getLine(id);
    db.prepare('UPDATE bill_lines SET clear_memo = ? WHERE id = ?').run(text(body.memo) || null, id);
    audit(ctx, 'billing.memo', { target: `line:${id}`, after: { memo: text(body.memo) } });
    return { ok: true };
  });

  // ------------------------------------------------------------ 引き渡し（FR-PAY-003・004。主催者管理者・受付係）
  route('POST', '/api/billing/lines/:id/deliver', (ctx, body, id) => {
    const me = needStaff(ctx, 'admin', 'reception');
    const l = getLine(id);
    if (l.kind === 'penalty' || l.kind === 'late' || l.kind === 'shipping') throw new HttpError(409, '違約金・遅延損害金・送料には、引き渡しはありません');
    if (l.cancelled_at) throw new HttpError(409, '解除した明細は、引き渡せません');
    if (!l.cleared_at) throw new HttpError(409, '消し込みが済んでいない明細は、引き渡せません');
    if (l.delivered_at) return { ok: true };
    db.prepare('UPDATE bill_lines SET delivered_at = ?, delivered_by = ? WHERE id = ?').run(nowMs(), me.id, id);
    audit(ctx, 'billing.deliver', { target: `line:${id}`, after: { delivered: true } });
    return { ok: true };
  });
  route('POST', '/api/billing/lines/:id/undeliver', (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const l = getLine(id);
    const reason = text(body.reason);
    if (!reason) throw bad('取り消しの理由を入力してください');
    if (!l.delivered_at) throw new HttpError(409, 'この明細は、引き渡しを記録していません');
    db.prepare('UPDATE bill_lines SET delivered_at = NULL, delivered_by = NULL WHERE id = ?').run(id);
    audit(ctx, 'billing.undeliver', { target: `line:${id}`, before: { delivered: true }, after: { delivered: false }, reason });
    return { ok: true };
  });
  // 開催終了の後の、受け取り方法の変更（明細ごと。主催者管理者だけ。FR-SHIP-008）。発行済みの請求書は出し直さない
  route('POST', '/api/billing/lines/:id/receive', (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const l = getLine(id);
    if (!RECV[body.receive]) throw bad('受け取り方法を選んでください');
    db.prepare('UPDATE bill_lines SET receive = ? WHERE id = ?').run(body.receive, id);
    audit(ctx, 'billing.receive', { target: `line:${id}`, before: { receive: l.receive }, after: { receive: body.receive } });
    return { ok: true };
  });
  return {  };
}
