// 未引き取り（現地受け取りの期限）と配送の一覧（報告書 119 章で、billing.js から分けた。中身は、分ける前と同じ）
import { csvCell, HttpError } from './shared.js';
import { compose, subjectOf, kv, jpDay } from './mails.js';
import iconv from 'iconv-lite';
import { CARRIERS, trackingUrl, normTracking, carrierRows, refOf, parseRef } from './carriers.js';
import { makeInvoiceList } from './invoice-files.js';

export function createPickup(deps) {
  const { account, audit, bad, db, displayName, invoiceAmounts, jst, needStaff, route, staffLineView, today, nowMs, getLine, notifier, setting, payable } = deps;
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
      const lines = list.map((l) => { const lot = lotOf.get(l.lot_id) ?? {}; return { id: l.id, lotNo: lot.lot_no ?? null, label: l.label, amount: l.amount, payable: payable(l), state: shipState(l), shippedOn: l.delivered_at ? jst(l.delivered_at) : null, memo: l.ship_memo ?? '',
        carrier: l.ship_carrier ?? '', tracking: l.ship_tracking ?? '', trackingUrl: trackingUrl(l.ship_carrier, l.ship_tracking), notifiedOn: l.ship_notified_at ? jst(l.ship_notified_at) : null }; });
      return { accountId, name: displayName(a), zip, address: addr, phone: telCsv(a.withdrawn_phone ?? a.phone), hasEmail: !!a.email, lines, fee,
        // 顧客としての状態: 全部送った / 一部送った / まだ（送れるものがある） / お支払い待ち（送れるものが無い）
        state: lines.every((l) => l.state === 'shipped') ? 'shipped' : lines.some((l) => l.state === 'shipped') ? 'partial' : lines.some((l) => l.state === 'ready') ? 'ready' : 'unpaid' };
    });
    // 住所・電話番号を見た記録（個人の情報のため）
    audit(ctx, 'view.shipping', { target: id === null ? 'shipping' : `shipping:event:${id}`, after: { customers: customers.length } });
    // 印刷（宛名ラベル・納品書・作業票）で使う、ご依頼主（主催者）と、運送会社の一覧
    const sender = { name: setting('org_name'), address: setting('org_address'), tel: setting('org_tel') };
    return { ok: true, today: today(), events, event: id, customers, sender, carriers: Object.entries(CARRIERS).map(([key, c]) => ({ key, name: c.name, system: c.system })) };
  });
  /**
   * 発送のお知らせメール（発注者の指示。報告書 131 章）: 配送済みにした品・運送会社・伝票番号・追跡のページを、落札者へ送る。
   * 取引に伴う連絡なので、開催のお知らせメールの受信の設定（広告・宣伝のメール）とは、関係なく送る
   */
  async function notifyShipped(accountId, lines, { carrier, tracking }) {
    const a = account(accountId);
    if (!a?.email) return false;
    const c = CARRIERS[carrier] ?? null;
    const url = trackingUrl(carrier, tracking);
    const ok = await notifier.email(a.email, 'shipped', subjectOf(`商品を発送しました（${lines.length}点）`), compose(setting, { name: displayName(a), lines: [
      '落札された商品を、発送しました。',
      '',
      ...lines.map((l) => `・${l.label}`),
      '',
      ...kv([['発送日', jpDay(today())], ['運送会社', c?.name ?? (carrier ? carrier : null)], ['伝票番号', tracking || null]]),
      ...(url ? ['', '配達の状況は、次のページで確かめられます（反映まで、時間がかかることがあります）。', url] : c?.page ? ['', `配達の状況は、${c.name}の「${c.pageName}」のページで、伝票番号を入れて確かめられます。`, c.page] : []),
      '',
      '届いた商品に、まちがいや不足があるときは、このメールにご返信ください。',
    ] }));
    if (ok) db.prepare(`UPDATE bill_lines SET ship_notified_at = ? WHERE id IN (${lines.map(() => '?').join(',')})`).run(nowMs(), ...lines.map((l) => l.id));
    return ok;
  }
  /** まとめて、配送済みにする（1回の操作は、全部できるか、何もしないか）。lineIds は、同じ画面で選んだ明細 */
  route('POST', '/api/billing/shipping/ship', async (ctx, body) => {
    const me = needStaff(ctx, 'admin', 'reception');
    const ids = [...new Set((Array.isArray(body.lineIds) ? body.lineIds : []).map(Number))].filter(Number.isInteger);
    if (!ids.length || ids.length > 2000) throw bad('配送済みにする品を、選んでください');
    const memo = String(body.memo ?? '').trim().slice(0, 200);
    const carrier = CARRIERS[body.carrier] ? body.carrier : '';
    const tracking = normTracking(body.tracking);
    const lines = ids.map((i) => getLine(i));
    for (const l of lines) {
      if (l.receive !== 'ship' || !['lot', 'promote'].includes(l.kind)) throw new HttpError(409, `「${l.label}」は、配送の品ではありません`);
      if (l.cancelled_at) throw new HttpError(409, `「${l.label}」は、落札を解除しています`);
      if (!l.cleared_at) throw new HttpError(409, `「${l.label}」は、お支払いの確認（消し込み）が済んでいないので、配送済みにできません`);
    }
    const todo = lines.filter((l) => !l.delivered_at);
    const now = nowMs();
    db.transaction(() => { for (const l of todo) db.prepare('UPDATE bill_lines SET delivered_at = ?, delivered_by = ?, ship_memo = ?, ship_carrier = ?, ship_tracking = ? WHERE id = ?').run(now, me.id, memo || null, carrier || null, tracking || null, l.id); })();
    for (const l of todo) audit(ctx, 'billing.deliver', { target: `line:${l.id}`, after: { delivered: true, via: 'shipping', carrier: carrier || null, tracking: tracking || null, memo: memo || null } });
    // 発送のお知らせ: 落札者ごとに1通（この操作で、配送済みにした品だけ）。送れなくても、配送済みの記録は残す
    let notified = 0, notifyFailed = 0;
    if (body.notify !== false) {
      const byAccount = new Map();
      for (const l of todo) { if (!byAccount.has(l.account_id)) byAccount.set(l.account_id, []); byAccount.get(l.account_id).push(l); }
      for (const [accountId, list] of byAccount) { if (await notifyShipped(accountId, list, { carrier, tracking })) notified++; else notifyFailed++; }
    }
    return { ok: true, shipped: todo.length, notified, notifyFailed };
  });
  // ---- 運送会社の送り状発行システムへ取り込むファイル（ヤマト運輸 B2クラウド・佐川急便 e飛伝Ⅲ。報告書 131 章）
  // 1人の顧客（1つの荷物）につき1行。お支払いの確認が済んでいて、まだ配送していない品のある顧客だけ。文字コードは Shift_JIS（両社のシステムと、表計算ソフトに合わせる）
  route('GET', '/api/billing/shipping/carrier.csv', (ctx) => {
    needStaff(ctx, 'admin');
    const ev = exportEvent(ctx);
    if (!ev) throw bad('開催を選んでください');
    const carrier = ctx.url.searchParams.get('carrier'), form = ctx.url.searchParams.get('form') === 'simple' ? 'simple' : 'standard';
    if (!CARRIERS[carrier]) throw bad('運送会社を選んでください');
    const rows = db.prepare("SELECT * FROM bill_lines WHERE event_id = ? AND receive = 'ship' AND cancelled_at IS NULL AND kind IN ('lot','promote') AND cleared_at IS NOT NULL AND delivered_at IS NULL ORDER BY account_id, id").all(ev.id);
    const byAccount = new Map();
    for (const l of rows) { if (!byAccount.has(l.account_id)) byAccount.set(l.account_id, []); byAccount.get(l.account_id).push(l); }
    const customers = [...byAccount].map(([accountId, lines]) => { const a = account(accountId); const [zip, addr] = addressParts(a); return { accountId, name: displayName(a), zip, address: addr, phone: telCsv(a.withdrawn_phone ?? a.phone), lines }; });
    const t = carrierRows(carrier, form, { eventId: ev.id, shipDate: today(), customers, sender: { name: setting('org_name'), address: setting('org_address'), tel: setting('org_tel') },
      codes: { yamatoBillingCode: setting('yamato_billing_code'), yamatoFareNo: setting('yamato_fare_no'), sagawaCustomerCode: setting('sagawa_customer_code') } });
    audit(ctx, 'billing.carrier_export', { target: `shipping:event:${ev.id}`, after: { carrier, form, rows: t.rows.length } });
    // Shift_JIS に無い文字（一部の人名の漢字・絵文字など）は「?」になる。運送会社のシステムの側で、直す
    const text = [t.header, ...t.rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    return { file: { body: iconv.encode(text, 'cp932'), type: 'text/csv; charset=Shift_JIS', name: `${carrier}-${form}-${ev.date}-event${ev.id}.csv` } };
  });
  /**
   * 運送会社のシステムが出した「発行済みのデータ」から、伝票番号を取り込む。画面で読んだ表のうち、お客様管理番号と伝票番号の組を受け取る。
   * 組ごとに、その顧客の、お支払いの確認が済んだ未配送の品を、配送済みにする（すでに配送済みで、伝票番号の無い品には、伝票番号だけを入れる）
   */
  route('POST', '/api/billing/shipping/import', async (ctx, body) => {
    const me = needStaff(ctx, 'admin');
    const carrier = CARRIERS[body.carrier] ? body.carrier : '';
    if (!carrier) throw bad('運送会社を選んでください');
    const pairs = (Array.isArray(body.rows) ? body.rows : []).slice(0, 5000);
    if (!pairs.length) throw bad('取り込む行が、ありません');
    const now = nowMs();
    const result = { shipped: 0, customers: 0, updated: 0, notified: 0, notifyFailed: 0, unknown: [], unpaid: [], noNumber: [] };
    const mails = [];
    db.transaction(() => {
      for (const row of pairs) {
        const ref = parseRef(row.ref), tracking = normTracking(row.tracking);
        if (!ref) { if (String(row.ref ?? '').trim()) result.unknown.push(String(row.ref).slice(0, 40)); continue; }
        if (!tracking) { result.noNumber.push(refOf(ref.eventId, ref.accountId)); continue; }
        const lines = db.prepare("SELECT * FROM bill_lines WHERE event_id = ? AND account_id = ? AND receive = 'ship' AND cancelled_at IS NULL AND kind IN ('lot','promote')").all(ref.eventId, ref.accountId);
        if (!lines.length) { result.unknown.push(refOf(ref.eventId, ref.accountId)); continue; }
        const todo = lines.filter((l) => l.cleared_at && !l.delivered_at);
        const fill = lines.filter((l) => l.delivered_at && !l.ship_tracking);
        for (const l of todo) db.prepare('UPDATE bill_lines SET delivered_at = ?, delivered_by = ?, ship_carrier = ?, ship_tracking = ? WHERE id = ?').run(now, me.id, carrier, tracking, l.id);
        for (const l of fill) db.prepare('UPDATE bill_lines SET ship_carrier = ?, ship_tracking = ? WHERE id = ?').run(carrier, tracking, l.id);
        if (!todo.length && !fill.length && lines.some((l) => !l.cleared_at)) result.unpaid.push(refOf(ref.eventId, ref.accountId));
        result.shipped += todo.length; result.updated += fill.length;
        if (todo.length) { result.customers++; mails.push({ accountId: ref.accountId, lines: todo, tracking }); }
        for (const l of todo) audit(ctx, 'billing.deliver', { target: `line:${l.id}`, after: { delivered: true, via: 'import', carrier, tracking } });
      }
    })();
    if (body.notify !== false) for (const m of mails) { if (await notifyShipped(m.accountId, m.lines, { carrier, tracking: m.tracking })) result.notified++; else result.notifyFailed++; }
    audit(ctx, 'billing.carrier_import', { target: 'shipping', after: { carrier, rows: pairs.length, shipped: result.shipped, customers: result.customers } });
    return { ok: true, ...result };
  });

  /** 配送済みを、取り消す（主催者管理者だけ。理由が要る） */
  route('POST', '/api/billing/shipping/unship', (ctx, body) => {
    needStaff(ctx, 'admin');
    const ids = [...new Set((Array.isArray(body.lineIds) ? body.lineIds : []).map(Number))].filter(Number.isInteger);
    const reason = String(body.reason ?? '').trim().slice(0, 500);
    if (!ids.length) throw bad('取り消す品を、選んでください');
    if (!reason) throw bad('取り消しの理由を入力してください');
    const todo = ids.map((i) => getLine(i)).filter((l) => l.delivered_at && l.receive === 'ship');
    db.transaction(() => { for (const l of todo) db.prepare('UPDATE bill_lines SET delivered_at = NULL, delivered_by = NULL, ship_memo = NULL, ship_carrier = NULL, ship_tracking = NULL, ship_notified_at = NULL WHERE id = ?').run(l.id); })();
    for (const l of todo) audit(ctx, 'billing.undeliver', { target: `line:${l.id}`, before: { delivered: true }, after: { delivered: false, via: 'shipping' }, reason });
    return { ok: true, unshipped: todo.length };
  });
  /** 配送のメモ（伝票番号など）だけを、直す */
  route('POST', '/api/billing/shipping/memo', async (ctx, body) => {
    needStaff(ctx, 'admin', 'reception');
    const ids = [...new Set((Array.isArray(body.lineIds) ? body.lineIds : []).map(Number))].filter(Number.isInteger);
    const memo = String(body.memo ?? '').trim().slice(0, 200);
    if (!ids.length) throw bad('品を、選んでください');
    const todo = ids.map((i) => getLine(i)).filter((l) => l.receive === 'ship');
    // 運送会社・伝票番号は、送ってきたときだけ直す（前の版の画面は、メモだけを送る）
    const withCarrier = body.carrier !== undefined || body.tracking !== undefined;
    const carrier = CARRIERS[body.carrier] ? body.carrier : '', tracking = normTracking(body.tracking);
    db.transaction(() => { for (const l of todo) {
      if (withCarrier) db.prepare('UPDATE bill_lines SET ship_memo = ?, ship_carrier = ?, ship_tracking = ? WHERE id = ?').run(memo || null, carrier || null, tracking || null, l.id);
      else db.prepare('UPDATE bill_lines SET ship_memo = ? WHERE id = ?').run(memo || null, l.id);
    } })();
    audit(ctx, 'billing.ship_memo', { target: `lines:${todo.map((l) => l.id).join(',')}`, after: { memo: memo || null, ...(withCarrier ? { carrier: carrier || null, tracking: tracking || null } : {}) } });
    // 伝票番号を直したあとで、お知らせを送り直す（指示があったときだけ）
    let notified = 0;
    if (body.notify === true) {
      const byAccount = new Map();
      for (const l of todo.filter((x) => x.delivered_at)) { if (!byAccount.has(l.account_id)) byAccount.set(l.account_id, []); byAccount.get(l.account_id).push(l); }
      for (const [accountId, list] of byAccount) { const now = list.map((l) => getLine(l.id)); if (await notifyShipped(accountId, now, { carrier: now[0].ship_carrier, tracking: now[0].ship_tracking })) notified++; }
    }
    return { ok: true, notified };
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
