// 未引き取り（現地受け取りの期限）と配送の一覧（報告書 119 章で、billing.js から分けた。中身は、分ける前と同じ）
import { csvCell, HttpError } from './shared.js';
import { makeInvoiceList } from './invoice-files.js';

export function createPickup(deps) {
  const { account, audit, bad, db, displayName, invoiceAmounts, jst, needStaff, route, staffLineView, today, nowMs, getLine } = deps;
  // ------------------------------------------------------------ 未引き取り（現地受け取り。FR-PAY-008）と、配送の一覧（FR-SHIP-005）
  route('GET', '/api/billing/pickup', (ctx) => {
    needStaff(ctx, 'admin', 'auctioneer', 'reception');
    const rows = db.prepare("SELECT * FROM bill_lines WHERE receive = 'pickup' AND cleared_at IS NOT NULL AND delivered_at IS NULL AND cancelled_at IS NULL AND kind IN ('lot','promote') ORDER BY cleared_at").all();
    return { today: today(), lines: rows.map(staffLineView) };
  });
  // CSV の共通（発注者の指示で見直した。報告書 70 章）。表計算ソフトで開いたときに、値が化けないようにする:
  // 電話番号・郵便番号は、ハイフンを入れる（数字だけだと、先頭の 0 が消える）。品番と品名は、別の列にする
  const telCsv = (p) => (/^0\d{9,10}$/.test(p ?? '') ? (p.length === 11 ? `${p.slice(0, 3)}-${p.slice(3, 7)}-${p.slice(7)}` : `${p.slice(0, 2)}-${p.slice(2, 6)}-${p.slice(6)}`) : p ?? '');
  const zipCsv = (z) => (/^\d{7}$/.test(z ?? '') ? `${z.slice(0, 3)}-${z.slice(3)}` : '');
  const lotOf = db.prepare('SELECT l.lot_no, l.title, e.starts_at FROM lots l LEFT JOIN events e ON e.id = l.event_id WHERE l.id = ?');
  const csvFile = (header, rows, name) => ({ file: { body: Buffer.from('\ufeff' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'), type: 'text/csv; charset=utf-8', name } });
  /** 住所を、郵便番号とそれ以外に分ける。分けて登録された住所はその値、自由に書かれた配送先は、先頭の「〒123-4567」を取り出す */
  function addressParts(a) {
    if (a.ship_to) {
      const m = /^\s*〒?\s*(\d{3})[-－ー]?(\d{4})\s*/.exec(a.ship_to);
      return m ? [`${m[1]}-${m[2]}`, a.ship_to.slice(m[0].length)] : ['', a.ship_to];
    }
    if (a.postal_code && a.address1) return [zipCsv(a.postal_code), `${a.prefecture ?? ''}${a.address1}${a.address2 ? ' ' + a.address2 : ''}`];
    return ['', a.address ?? ''];
  }
  // 書き出しは、画面で選んだ開催に合わせる（発注者の決定。報告書 125 章）: ?event=番号 があれば、その開催の分だけ。無ければ、これまでどおり（全部・月ごと）
  const exportEvent = (ctx) => {
    const want = ctx.url.searchParams.get('event');
    if (!want || want === 'all') return null;
    const e = db.prepare('SELECT id, title, substr(starts_at, 1, 10) AS date FROM events WHERE id = ?').get(Number(want));
    if (!e) throw new HttpError(404, '開催が見つかりません');
    return e;
  };
  route('GET', '/api/billing/shipping.csv', (ctx) => {
    needStaff(ctx, 'admin');
    const ev = exportEvent(ctx);
    const rows = db.prepare("SELECT * FROM bill_lines WHERE receive = 'ship' AND cancelled_at IS NULL AND kind IN ('lot','promote') ORDER BY account_id, id").all().filter((l) => !ev || l.event_id === ev.id);
    const out = rows.map((l) => {
      const a = account(l.account_id), lot = lotOf.get(l.lot_id) ?? {};
      const [zip, addr] = addressParts(a);
      return [lot.starts_at?.slice(0, 10) ?? '', lot.lot_no ?? '', lot.title ?? l.label, l.amount, displayName(a), zip, addr, telCsv(a.withdrawn_phone ?? a.phone),
        l.cleared_at ? jst(l.cleared_at) : '', l.delivered_at ? jst(l.delivered_at) : ''];
    });
    audit(ctx, 'billing.shipping_export', { target: ev ? `shipping:event:${ev.id}` : 'shipping.csv', after: { rows: rows.length } });
    return csvFile(['開催日', '品番', '品名', '落札額（税込）', '氏名・会社名', '郵便番号', '配送先の住所', '電話番号', '入金の確認日', '引き渡しの日'], out, ev ? `shipping-${ev.date}-event${ev.id}.csv` : `shipping-${today()}.csv`);
  });

  // ------------------------------------------------------------ 配送の管理（発注者の指示。報告書 130 章）
  // 開催ごとに、配送を選んだ品を、落札者（顧客）ごとにまとめて出す。配送済みの記録は、顧客ごとに、まとめて付ける。品ごとにも付けられる。
  // 「配送済み」は、引き渡しの記録（delivered_at）と同じもの（帳簿用の記録の「引き渡しの日」にも、この日が出る）。お支払いの確認の前には、付けられない
  const shipState = (l) => (l.delivered_at ? 'shipped' : l.cleared_at ? 'ready' : 'unpaid');
  route('GET', '/api/billing/shipping', (ctx) => {
    needStaff(ctx, 'admin', 'reception');
    // 配送の品のある開催だけを、選べるようにする
    const events = db.prepare(`SELECT e.id, e.title, substr(e.starts_at, 1, 10) AS date, COUNT(l.id) AS lines,
      SUM(CASE WHEN l.delivered_at IS NULL THEN 1 ELSE 0 END) AS open
      FROM events e JOIN bill_lines l ON l.event_id = e.id AND l.receive = 'ship' AND l.cancelled_at IS NULL AND l.kind IN ('lot','promote')
      GROUP BY e.id ORDER BY e.starts_at DESC, e.id DESC`).all();
    const want = ctx.url.searchParams.get('event');
    const id = events.find((e) => String(e.id) === want)?.id ?? events[0]?.id ?? null;
    const rows = id === null ? [] : db.prepare("SELECT * FROM bill_lines WHERE event_id = ? AND receive = 'ship' AND cancelled_at IS NULL AND kind IN ('lot','promote') ORDER BY account_id, id").all(id);
    const byAccount = new Map();
    for (const l of rows) { if (!byAccount.has(l.account_id)) byAccount.set(l.account_id, []); byAccount.get(l.account_id).push(l); }
    const customers = [...byAccount].map(([accountId, list]) => {
      const a = account(accountId);
      const [zip, addr] = addressParts(a);
      const fee = db.prepare("SELECT label, amount FROM bill_lines WHERE event_id = ? AND account_id = ? AND kind = 'shipping' AND cancelled_at IS NULL ORDER BY id DESC LIMIT 1").get(id, accountId) ?? null;
      const lines = list.map((l) => { const lot = lotOf.get(l.lot_id) ?? {}; return { id: l.id, lotNo: lot.lot_no ?? null, label: l.label, amount: l.amount, state: shipState(l), shippedOn: l.delivered_at ? jst(l.delivered_at) : null, memo: l.ship_memo ?? '' }; });
      return { accountId, name: displayName(a), zip, address: addr, phone: telCsv(a.withdrawn_phone ?? a.phone), lines, fee,
        // 顧客としての状態: 全部送った / 一部送った / まだ（送れるものがある） / お支払い待ち（送れるものが無い）
        state: lines.every((l) => l.state === 'shipped') ? 'shipped' : lines.some((l) => l.state === 'shipped') ? 'partial' : lines.some((l) => l.state === 'ready') ? 'ready' : 'unpaid' };
    });
    // 住所・電話番号を見た記録（個人の情報のため）
    audit(ctx, 'view.shipping', { target: id === null ? 'shipping' : `shipping:event:${id}`, after: { customers: customers.length } });
    return { ok: true, today: today(), events, event: id, customers };
  });
  /** まとめて、配送済みにする（1回の操作は、全部できるか、何もしないか）。lineIds は、同じ画面で選んだ明細 */
  route('POST', '/api/billing/shipping/ship', (ctx, body) => {
    const me = needStaff(ctx, 'admin', 'reception');
    const ids = [...new Set((Array.isArray(body.lineIds) ? body.lineIds : []).map(Number))].filter(Number.isInteger);
    if (!ids.length || ids.length > 2000) throw bad('配送済みにする品を、選んでください');
    const memo = String(body.memo ?? '').trim().slice(0, 200);
    const lines = ids.map((i) => getLine(i));
    for (const l of lines) {
      if (l.receive !== 'ship' || !['lot', 'promote'].includes(l.kind)) throw new HttpError(409, `「${l.label}」は、配送の品ではありません`);
      if (l.cancelled_at) throw new HttpError(409, `「${l.label}」は、落札を解除しています`);
      if (!l.cleared_at) throw new HttpError(409, `「${l.label}」は、お支払いの確認（消し込み）が済んでいないので、配送済みにできません`);
    }
    const todo = lines.filter((l) => !l.delivered_at);
    const now = nowMs();
    db.transaction(() => { for (const l of todo) db.prepare('UPDATE bill_lines SET delivered_at = ?, delivered_by = ?, ship_memo = ? WHERE id = ?').run(now, me.id, memo || null, l.id); })();
    for (const l of todo) audit(ctx, 'billing.deliver', { target: `line:${l.id}`, after: { delivered: true, via: 'shipping', memo: memo || null } });
    return { ok: true, shipped: todo.length };
  });
  /** 配送済みを、取り消す（主催者管理者だけ。理由が要る） */
  route('POST', '/api/billing/shipping/unship', (ctx, body) => {
    needStaff(ctx, 'admin');
    const ids = [...new Set((Array.isArray(body.lineIds) ? body.lineIds : []).map(Number))].filter(Number.isInteger);
    const reason = String(body.reason ?? '').trim().slice(0, 500);
    if (!ids.length) throw bad('取り消す品を、選んでください');
    if (!reason) throw bad('取り消しの理由を入力してください');
    const todo = ids.map((i) => getLine(i)).filter((l) => l.delivered_at && l.receive === 'ship');
    db.transaction(() => { for (const l of todo) db.prepare('UPDATE bill_lines SET delivered_at = NULL, delivered_by = NULL, ship_memo = NULL WHERE id = ?').run(l.id); })();
    for (const l of todo) audit(ctx, 'billing.undeliver', { target: `line:${l.id}`, before: { delivered: true }, after: { delivered: false, via: 'shipping' }, reason });
    return { ok: true, unshipped: todo.length };
  });
  /** 配送のメモ（伝票番号など）だけを、直す */
  route('POST', '/api/billing/shipping/memo', (ctx, body) => {
    needStaff(ctx, 'admin', 'reception');
    const ids = [...new Set((Array.isArray(body.lineIds) ? body.lineIds : []).map(Number))].filter(Number.isInteger);
    const memo = String(body.memo ?? '').trim().slice(0, 200);
    if (!ids.length) throw bad('品を、選んでください');
    const todo = ids.map((i) => getLine(i)).filter((l) => l.receive === 'ship');
    db.transaction(() => { for (const l of todo) db.prepare('UPDATE bill_lines SET ship_memo = ? WHERE id = ?').run(memo || null, l.id); })();
    audit(ctx, 'billing.ship_memo', { target: `lines:${todo.map((l) => l.id).join(',')}`, after: { memo: memo || null } });
    return { ok: true };
  });

  // 古物営業法16条の帳簿に使うための、取引の記録（FR-LEG-001）。引き渡した品を、日付・品目・数量・特徴・相手方で出す
  route('GET', '/api/billing/ledger.csv', (ctx) => {
    needStaff(ctx, 'admin');
    const month = ctx.url.searchParams.get('month') ?? today().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw bad('月を、2026-12 の形で指定してください');
    const ev = exportEvent(ctx);
    // 開催を選んでいるときは、その開催の品のうち、引き渡したもの（月をまたいで引き渡した分も入る）。選んでいないときは、その月に引き渡したもの
    const rows = db.prepare("SELECT * FROM bill_lines WHERE kind IN ('lot','promote') AND delivered_at IS NOT NULL ORDER BY delivered_at").all().filter((l) => (ev ? l.event_id === ev.id : jst(l.delivered_at).startsWith(month)));
    const out = rows.map((l) => {
      const a = account(l.account_id), lot = lotOf.get(l.lot_id) ?? {};
      return [jst(l.delivered_at), lot.lot_no ?? '', lot.title ?? l.label, 1, '', l.amount, displayName(a), a.address, telCsv(a.withdrawn_phone ?? a.phone)];
    });
    audit(ctx, 'billing.ledger_export', { target: ev ? `ledger:event:${ev.id}` : `ledger:${month}`, after: { rows: rows.length } });
    return csvFile(['引き渡しの日', '品番', '品目', '数量', '特徴', '代金（税込）', '相手方の氏名・名称', '相手方の住所', '相手方の電話番号'], out, ev ? `ledger-${ev.date}-event${ev.id}.csv` : `ledger-${month}.csv`);
  });
  // 月ごとに、全請求書を1つの Excel にまとめた一覧（FR-INV-007）
  route('GET', '/api/billing/invoices.xlsx', async (ctx) => {
    needStaff(ctx, 'admin');
    const month = ctx.url.searchParams.get('month') ?? today().slice(0, 7);
    const ev = exportEvent(ctx);
    const list = db.prepare('SELECT * FROM invoices ORDER BY id').all().filter((i) => (ev ? i.event_id === ev.id : jst(i.issued_at).startsWith(month)));
    const KIND = { cash: '現金の精算', transfer: '振込', promote: '繰り上げ', penalty: '違約金など' };
    const rows = list.map((i) => {
      // 解除した明細は、請求額にも入金にも数えない。すべて解除した請求書は「解除」
      const m = invoiceAmounts(i);
      const state = m.cancelled === m.lines ? '解除' : m.paid === m.due ? '支払済み' : m.paid > 0 ? '一部支払済み' : '未払い';
      return [i.number, KIND[i.kind], displayName(account(i.account_id)), jst(i.issued_at), i.sent_at ? jst(i.sent_at) : '', i.due_date ?? '', m.due, m.paid, m.cancelled && m.cancelled < m.lines ? `${state}（一部解除）` : state];
    });
    audit(ctx, 'billing.invoices_export', { target: ev ? `invoices:event:${ev.id}` : `invoices:${month}`, after: { rows: rows.length } });
    return { file: { body: await makeInvoiceList(ev ? ev.date : month, rows), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: ev ? `invoices-${ev.date}-event${ev.id}.xlsx` : `invoices-${month}.xlsx` } };
  });
  return {  };
}
