// 請求書の一覧・送付済みの記録・ファイルの受け口（報告書 119 章で、billing.js から分けた。中身は、分ける前と同じ）
import fs from 'node:fs';
import { DAY, addDays } from './shared.js';

export function createInvoiceRoutes(deps) {
  const { HttpError, account, audit, db, displayName, invoiceAmounts, invoiceMail, jst, listLimit, needStaff, nowMs, renderInvoice, route, setting, today } = deps;
  // ------------------------------------------------------------ 請求書の一覧・送付済み（FR-INV-008）・ファイル
  const invoiceView = (i) => {
    const a = account(i.account_id);
    const m = invoiceAmounts(i);
    return {
      // total: 解除した明細を除いた、いま払ってもらう金額。issuedTotal: 発行したときの請求額（請求書の PDF に書いた金額）
      id: i.id, number: i.number, kind: i.kind, name: displayName(a), email: a.email, total: m.due, issuedTotal: i.total, cancelled: m.cancelled, paid: m.paid, issuedOn: jst(i.issued_at),
      void: m.lines === 0, // 精算をすべて取り消した（無効の領収書）
      sentOn: i.sent_at ? jst(i.sent_at) : null, dueDate: i.due_date, draft: i.draft_state, accountId: i.account_id, eventId: i.event_id,
      shipping: db.prepare("SELECT amount, label FROM bill_lines WHERE invoice_id = ? AND kind = 'shipping'").get(i.id) ?? null,
      // 下書きを作ってから1日たっても送付済みにならない請求書は、強調する
      stale: i.kind !== 'cash' && !i.sent_at && nowMs() - i.issued_at > DAY,
    };
  };
  route('GET', '/api/billing/invoices', (ctx) => {
    needStaff(ctx, 'admin');
    // 新しい順に limit 件。ただし、まだ入金のない明細を含む請求書は、古くても必ず出す
    const limit = listLimit(ctx, 1000);
    const rows = db.prepare(`SELECT * FROM invoices i WHERE id >= coalesce((SELECT id FROM invoices ORDER BY id DESC LIMIT 1 OFFSET ?), 0)
      OR EXISTS (SELECT 1 FROM bill_lines l WHERE l.invoice_id = i.id AND l.cleared_at IS NULL AND l.cancelled_at IS NULL) ORDER BY id DESC`).all(limit - 1);
    return { invoices: rows.map(invoiceView), limit, more: db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n > rows.length };
  });
  route('POST', '/api/billing/invoices/:id/sent', async (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const i = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!i) throw new HttpError(404, '請求書が見つかりません');
    if (i.kind === 'cash') throw new HttpError(409, '当日現金の精算の請求書は、その場で渡すので、送付の記録はありません');
    if (i.sent_at) return { ok: true, dueDate: i.due_date };
    // 送ったことを記録する（FR-INV-008）。支払期限は、発行したときに決まっている（発行日の5日後）。
    // ただし、送るのが遅れて、期限が今日より前になっている請求書は、今日の発行として期限を決め直し、作り直す（本番運用の評価 B2）
    if (i.due_date && i.due_date < today() && i.due_days) {
      db.prepare('UPDATE invoices SET issued_at = ?, due_date = ? WHERE id = ?').run(nowMs(), addDays(today(), i.due_days), id);
      await renderInvoice(i.id).done;
    }
    db.prepare('UPDATE invoices SET sent_at = ? WHERE id = ?').run(nowMs(), id);
    i.due_date = db.prepare('SELECT due_date FROM invoices WHERE id = ?').get(id).due_date;
    audit(ctx, 'invoice.sent', { target: `invoice:${i.number}`, after: { sentOn: today(), dueDate: i.due_date } });
    return { ok: true, dueDate: i.due_date };
  });
  route('POST', '/api/billing/invoices/:id/unsent', (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const i = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!i?.sent_at) throw new HttpError(409, '送付済みの記録がありません');
    db.prepare('UPDATE invoices SET sent_at = NULL WHERE id = ?').run(id);
    audit(ctx, 'invoice.unsent', { target: `invoice:${i.number}`, before: { sentOn: jst(i.sent_at), dueDate: i.due_date } });
    return { ok: true };
  });
  const sendFile = async (i, kind) => {
    let file = kind === 'pdf' ? i.pdf_file : i.xlsx_file;
    // ファイルが無いとき（作っている最中にサーバーが落ちた・保存先へ送る前に入れ替わった）は、その場で作り直す。
    // 作り直しは、いまの明細の内容になる
    if (!file || !fs.existsSync(file)) {
      await renderInvoice(i.id).done;
      const again = db.prepare('SELECT pdf_file, xlsx_file FROM invoices WHERE id = ?').get(i.id);
      file = kind === 'pdf' ? again.pdf_file : again.xlsx_file;
      if (!file || !fs.existsSync(file)) throw new HttpError(404, 'ファイルが見つかりません');
    }
    return { file: { body: fs.readFileSync(file), type: kind === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: `${i.number}.${kind}` } };
  };
  route('GET', '/api/billing/invoices/:id/pdf', (ctx, body, id) => {
    const i = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    // 主催者管理者・受付係（精算の領収書を渡す）と、その請求書の本人だけが開ける
    if (!i || !(ctx.staff && ['admin', 'reception'].includes(ctx.staff.role)) && ctx.member?.id !== i.account_id) throw new HttpError(404, '請求書が見つかりません');
    // スタッフが、会員の請求書（氏名・住所が載る）を開いた記録（本番運用の評価 C）
    if (ctx.staff) audit(ctx, 'view.invoice', { target: `invoice:${i.number}`, after: { file: 'pdf' } });
    return sendFile(i, 'pdf');
  });
  // 送付用のメールの文面（宛先・件名・本文）。下書きは、利用会社のメールソフトには届かないので、管理画面から写して送れるようにする（報告書 118 章）
  route('GET', '/api/billing/invoices/:id/mail', (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ? AND kind <> 'cash'").get(id);
    if (!inv) throw new HttpError(404, '請求書が見つかりません');
    const all = db.prepare('SELECT * FROM bill_lines WHERE invoice_id = ? ORDER BY id').all(id);
    const a = account(inv.account_id);
    const org = Object.fromEntries(['org_name', 'org_address', 'org_tel', 'org_email', 'invoice_reg_no', 'bank_account'].map((k) => [k, setting(k)]));
    const mail = invoiceMail(inv, all.filter((l) => l.kind !== 'shipping'), all.filter((l) => l.kind === 'shipping'), a, org);
    audit(ctx, 'view.invoice', { target: `invoice:${inv.number}`, after: { file: 'mail' } });
    return { ok: true, to: a.email, subject: mail.subject, body: mail.body };
  });
  route('GET', '/api/billing/invoices/:id/xlsx', (ctx, body, id) => {
    needStaff(ctx, 'admin'); // 落札者にも Excel を渡すかは未決（OQ-28）なので、主催者管理者だけ
    const i = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!i) throw new HttpError(404, '請求書が見つかりません');
    audit(ctx, 'view.invoice', { target: `invoice:${i.number}`, after: { file: 'xlsx' } });
    return sendFile(i, 'xlsx');
  });
  return {  };
}
