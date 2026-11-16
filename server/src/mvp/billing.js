// MVP の 6: 請求書の自動発行、入金の消し込み、引き渡し、未払い・解除・繰り上げ・違約金・返金、未引き取り、手数料の集計。
// 決済はしない（決定）。現金も振込も、システムの外で受け取り、ここには「消し込み」だけを記録する。
// 送料は一切扱わない（FR-SHIP-001）。請求書に載せるのは、落札代金と、違約金・遅延損害金だけ。
import fs from 'node:fs';
import path from 'node:path';
import { makeInvoiceFiles } from './invoice-files.js';

export const BILLING_SCHEMA = `
-- 明細: 落札した品1つにつき1行（FR-INV-003）。違約金・遅延損害金・繰り上げも、同じ形の行として持つ
CREATE TABLE IF NOT EXISTS bill_lines (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('lot','promote','penalty','late')),
  event_id INTEGER NOT NULL, lot_id INTEGER, participant_id INTEGER, account_id INTEGER NOT NULL,
  label TEXT NOT NULL,                     -- 請求書に載せる名前（No. と品名）
  amount INTEGER NOT NULL CHECK (amount > 0),   -- 税込
  receive TEXT,                            -- 受け取り方法（いまの値。開催終了の後は、主催者管理者が明細ごとに変えられる）
  invoice_id INTEGER,                      -- 載っている請求書。まだ精算も請求もしていなければ NULL
  cleared_at REAL, cleared_method TEXT, cleared_by INTEGER, clear_memo TEXT,   -- 消し込み
  delivered_at REAL, delivered_by INTEGER,                                    -- 引き渡し
  cancelled_at REAL, cancel_reason TEXT,   -- 解除（取り消せない。FR-PAY-006）
  parent_line_id INTEGER,                  -- 違約金・繰り上げの、元の明細
  created_at REAL NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS bill_lines_lot ON bill_lines(lot_id) WHERE kind = 'lot';
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,             -- 年月日-連番（FR-NUM-001）
  kind TEXT NOT NULL CHECK (kind IN ('cash','transfer','promote','penalty')),
  account_id INTEGER NOT NULL, event_id INTEGER NOT NULL,
  issued_at REAL NOT NULL, total INTEGER NOT NULL,
  receive_note TEXT NOT NULL DEFAULT '',   -- 備考に書く受け取り方法。発行した時点の値に固める（FR-INV-006）
  due_days INTEGER,                        -- 送付日の翌日から数えて何日目が支払期限か（現金の精算は NULL）
  shift_holiday INTEGER NOT NULL DEFAULT 0,  -- 期限が金融機関の休業日なら、前の営業日にするか
  sent_at REAL, due_date TEXT,             -- 送付日と、そこから決まる支払期限（FR-INV-008）
  pdf_file TEXT, xlsx_file TEXT,           -- 一度作ったファイルは、作り直さない
  draft_state TEXT NOT NULL DEFAULT 'none',  -- メールの下書き: none（作らない）/ made / failed
  overdue_notified INTEGER NOT NULL DEFAULT 0
);
-- 消し込みの履歴（手数料の月ごとの集計に使う。取り消しても行は残す）
CREATE TABLE IF NOT EXISTS clearings (
  id INTEGER PRIMARY KEY, line_id INTEGER NOT NULL, amount INTEGER NOT NULL, method TEXT NOT NULL,
  cleared_at REAL NOT NULL, reversed_at REAL, reverse_reason TEXT
);
CREATE TABLE IF NOT EXISTS dunning (id INTEGER PRIMARY KEY, line_id INTEGER NOT NULL, at REAL NOT NULL, method TEXT NOT NULL, body TEXT NOT NULL, staff_id INTEGER);
CREATE TABLE IF NOT EXISTS refunds (id INTEGER PRIMARY KEY, line_id INTEGER NOT NULL, amount INTEGER NOT NULL, refunded_on TEXT NOT NULL, method TEXT NOT NULL, reason TEXT NOT NULL, staff_id INTEGER, at REAL NOT NULL);
-- 繰り上げの打診（次点の1人だけ。FR-PAY-007）
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY, line_id INTEGER NOT NULL UNIQUE, participant_id INTEGER NOT NULL, account_id INTEGER NOT NULL,
  amount INTEGER NOT NULL, offered_at REAL NOT NULL, deadline TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','accepted','declined','expired')), answered_at REAL, new_line_id INTEGER
);
CREATE TABLE IF NOT EXISTS fee_confirms (month TEXT PRIMARY KEY, confirmed_at REAL NOT NULL, staff_id INTEGER);
CREATE TABLE IF NOT EXISTS pickup_notices (line_id INTEGER PRIMARY KEY, at REAL NOT NULL);
`;

const DAY = 86400000;
const PAY = { transfer: '銀行振込', cash: '当日現金' };
const RECV = { pickup: '現地受け取り', ship: '配送' };
const FEE_RATE = 5; // 手数料 5%（FR-FEE-001。決定）

/** 日付（YYYY-MM-DD）に日数を足す */
export const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

export function createBilling({ db, config, nowMs, audit, notifier, setting, route, needStaff, needMember, HttpError, bad }) {
  db.exec(BILLING_SCHEMA);
  const invoiceDir = path.join(config.dataDir, 'invoices');
  fs.mkdirSync(invoiceDir, { recursive: true });
  const jst = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10); // 日本時間の日付（DATA-006）
  const today = () => jst(nowMs());
  const yen = (n) => '¥' + Number(n).toLocaleString('ja-JP');
  const text = (v, max = 500) => String(v ?? '').trim().slice(0, max);
  const getLine = (id) => { const l = db.prepare('SELECT * FROM bill_lines WHERE id = ?').get(id); if (!l) throw new HttpError(404, '明細が見つかりません'); return l; };
  const account = (id) => db.prepare('SELECT * FROM member_accounts WHERE id = ?').get(id);
  const displayName = (a) => (a.kind === 'b2b' ? `${a.company}　${a.contact_name}` : a.name);

  // ------------------------------------------------------------ 期限の計算
  /** 金融機関の休業日: 土日と、主催者設定のカレンダー（FR-ORG-001） */
  const bankHolidays = () => new Set(setting('bank_holidays').split(/\s+/).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
  const isBankHoliday = (date, set) => { const w = new Date(date + 'T00:00:00Z').getUTCDay(); return w === 0 || w === 6 || set.has(date); };
  /** 支払期限: 送付日の翌日から数えて days 日目。shift なら、休業日のときは前の営業日（FR-INV-005） */
  function dueDate(sentDate, days, shift) {
    let d = addDays(sentDate, days);
    if (shift) { const set = bankHolidays(); while (isBankHoliday(d, set)) d = addDays(d, -1); }
    return d;
  }

  // ------------------------------------------------------------ 明細を作る（落札の確定 → 明細。FR-INV-001・003）
  /**
   * 落札した品のうち、まだ明細になっていないものを明細にする。何度呼んでも同じ結果になる
   * （締めの直後に落ちても、次に呼ばれたときに漏れなく作られる）。会員の参加者が落札した品だけが対象。
   */
  function syncLines() {
    const rows = db.prepare(`
      SELECT l.id AS lot_id, l.lot_no, l.title, l.event_id, b.amount, m.id AS participant_id, m.account_id, m.receive, m.paddle_no
      FROM lots l JOIN bids b ON b.seq = l.winner_bid_seq JOIN members m ON m.id = b.member_id
      WHERE l.status = 'sold' AND l.event_id IS NOT NULL AND m.account_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM bill_lines x WHERE x.lot_id = l.id AND x.kind = 'lot')`).all();
    for (const r of rows) {
      db.prepare('INSERT INTO bill_lines (kind, event_id, lot_id, participant_id, account_id, label, amount, receive, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run('lot', r.event_id, r.lot_id, r.participant_id, r.account_id, `No.${r.lot_no} ${r.title}`, r.amount, r.receive, nowMs());
      const a = account(r.account_id);
      // 落札者に、メールでも知らせる（画面には、締めの時点で出ている）
      notifier.email(a.email, 'won', '落札のお知らせ', `No.${r.lot_no} ${r.title} を、${yen(r.amount)}（税込）で落札しました。\nお支払いと受け取りについては、マイページをご覧ください。\n落札価格に送料は含まれません。`);
    }
    return rows.length;
  }

  // ------------------------------------------------------------ 請求書を発行する（FR-INV-002・004・007）
  function nextNumber() {
    const day = today().replaceAll('-', '');
    const n = db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE number LIKE ?").get(day + '-%').n + 1;
    return `${day}-${String(n).padStart(4, '0')}`;
  }
  /** lineIds の明細を載せた請求書を1通発行する。kind: cash（精算。領収書を兼ねる）/ transfer / promote / penalty */
  function issueInvoice(kind, lineIds, { dueDays = null, shiftHoliday = false, draft = false } = {}) {
    const lines = lineIds.map(getLine);
    const first = lines[0];
    const total = lines.reduce((s, l) => s + l.amount, 0);
    const receiveNote = [...new Set(lines.map((l) => RECV[l.receive]).filter(Boolean))].join('・');
    const info = db.transaction(() => {
      const number = nextNumber();
      const r = db.prepare('INSERT INTO invoices (number, kind, account_id, event_id, issued_at, total, receive_note, due_days, shift_holiday) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(number, kind, first.account_id, first.event_id, nowMs(), total, receiveNote, dueDays, shiftHoliday ? 1 : 0);
      for (const l of lines) db.prepare('UPDATE bill_lines SET invoice_id = ? WHERE id = ?').run(r.lastInsertRowid, l.id);
      return { id: Number(r.lastInsertRowid), number };
    })();
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(info.id);
    const a = account(first.account_id);
    // PDF と Excel を作る（内容は同じ。正本は PDF）。ファイルは作り直さずに残す
    const org = Object.fromEntries(['org_name', 'org_address', 'org_tel', 'org_email', 'invoice_reg_no', 'bank_account'].map((k) => [k, setting(k)]));
    const files = makeInvoiceFiles({
      dir: invoiceDir, invoice: inv, lines, org, to: { name: displayName(a), address: a.kind === 'b2b' && a.billing ? a.billing : a.address },
      issuedOn: jst(inv.issued_at), paidOn: kind === 'cash' ? jst(inv.issued_at) : null,
      // 件名: 開催日と開催の名前
      subject: (() => { const e = db.prepare('SELECT title, starts_at FROM events WHERE id = ?').get(first.event_id); return e ? `${Number(e.starts_at.slice(5, 7))}.${Number(e.starts_at.slice(8, 10))} ライブオークション ${e.title}` : 'ライブオークション'; })(),
    });
    db.prepare('UPDATE invoices SET pdf_file = ?, xlsx_file = ? WHERE id = ?').run(files.pdf, files.xlsx, inv.id);
    // 送付用のメールの下書き（FR-INV-007）。送信は、利用会社の担当者が自分で行う。当日現金の精算では作らない
    if (draft) {
      files.done.then(() => notifier.draft(a.email, `【${org.org_name}】ご請求書（${inv.number}）`, `${displayName(a)} 様\n\nライブオークションのご請求書をお送りします。\n請求書番号: ${inv.number}\nご請求額: ${yen(total)}（税込）\n\nお振込の際は、依頼人名に請求書番号を入れてください。振込手数料は、お客様のご負担となります。\n落札価格に送料は含まれません。`, [files.pdf]))
        .then((ok) => db.prepare('UPDATE invoices SET draft_state = ? WHERE id = ?').run(ok ? 'made' : 'failed', inv.id))
        .catch(() => db.prepare("UPDATE invoices SET draft_state = 'failed' WHERE id = ?").run(inv.id));
    }
    return { ...inv, done: files.done };
  }

  /** 開催終了（FR-EVT-003）: まだ精算していない明細を、落札者ごとに1通の振込の請求書にまとめる（FR-INV-004） */
  function onEventEnd(eventId, ctx) {
    syncLines();
    const groups = db.prepare("SELECT account_id, GROUP_CONCAT(id) AS ids FROM bill_lines WHERE event_id = ? AND kind = 'lot' AND invoice_id IS NULL AND cancelled_at IS NULL GROUP BY account_id").all(eventId);
    const made = groups.map((g) => issueInvoice('transfer', g.ids.split(',').map(Number), { dueDays: 5, shiftHoliday: true, draft: true }));
    if (made.length) audit(ctx, 'invoice.issue_on_end', { target: `event:${eventId}`, after: { invoices: made.map((i) => i.number) } });
    return made;
  }

  // ------------------------------------------------------------ 画面に出す形
  function lineView(l) {
    const inv = l.invoice_id ? db.prepare('SELECT * FROM invoices WHERE id = ?').get(l.invoice_id) : null;
    const overdue = !!inv?.due_date && inv.due_date < today() && !l.cleared_at && !l.cancelled_at;
    // 現地受け取りの期限: 消し込みの日の翌日から数えて7日目まで（FR-PAY-008）
    const pickupBy = l.receive === 'pickup' && l.cleared_at && l.kind !== 'penalty' && l.kind !== 'late' ? addDays(jst(l.cleared_at), 7) : null;
    return {
      id: l.id, kind: l.kind, label: l.label, amount: l.amount, receive: l.receive, eventId: l.event_id,
      invoice: inv ? { id: inv.id, number: inv.number, kind: inv.kind, sentOn: inv.sent_at ? jst(inv.sent_at) : null, dueDate: inv.due_date } : null,
      state: l.cancelled_at ? 'cancelled' : l.delivered_at ? 'delivered' : l.cleared_at ? 'cleared' : overdue ? 'unpaid' : inv ? 'billed' : 'unsettled',
      clearedOn: l.cleared_at ? jst(l.cleared_at) : null, clearedMethod: l.cleared_method, deliveredOn: l.delivered_at ? jst(l.delivered_at) : null,
      pickupBy, pickupLate: !!pickupBy && !l.delivered_at && pickupBy < today(),
      cancelReason: l.cancel_reason,
    };
  }
  const staffLineView = (l) => {
    const a = account(l.account_id);
    const p = l.participant_id ? db.prepare('SELECT paddle_no, payment, mode FROM members WHERE id = ?').get(l.participant_id) : null;
    return {
      ...lineView(l), name: displayName(a), accountId: a.id, paddle: p?.paddle_no ?? null, payment: p?.payment ?? null,
      dunning: db.prepare('SELECT at, method, body FROM dunning WHERE line_id = ? ORDER BY id').all(l.id),
      refunds: db.prepare('SELECT amount, refunded_on AS refundedOn, method, reason FROM refunds WHERE line_id = ? ORDER BY id').all(l.id),
      offer: db.prepare('SELECT state, amount, deadline FROM offers WHERE line_id = ?').get(l.id) ?? null,
      memo: l.clear_memo,
    };
  };

  // ------------------------------------------------------------ 一覧（主催者管理者・受付係。進行役は未引き取りだけ）
  route('GET', '/api/billing/lines', (ctx) => {
    needStaff(ctx, 'admin', 'reception');
    syncLines();
    return { today: today(), lines: db.prepare('SELECT * FROM bill_lines ORDER BY id DESC LIMIT 1000').all().map(staffLineView) };
  });

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
    const me = needStaff(ctx, 'admin');
    const l = getLine(id);
    if (l.cancelled_at) throw new HttpError(409, '解除した明細は、消し込めません。入金があった場合は、返金として記録してください'); // AC-FR-PAY-006-1
    if (l.cleared_at) throw new HttpError(409, 'この明細は、消し込み済みです');
    if (!l.invoice_id) throw new HttpError(409, 'まだ請求書を発行していない明細です。当日現金は「精算」で、振込は開催終了の後に消し込みます');
    // 明細の金額と入金の金額が一致するときだけ、消し込める（一部だけ・多すぎる入金の扱いは未決。OQ-26）
    if (Number(body.amount) !== l.amount) throw bad(`入金の金額が、明細の金額（${yen(l.amount)}）と一致しません。一致しない入金は、システムの外で対応し、理由をメモに残してください`);
    const now = nowMs();
    db.transaction(() => {
      db.prepare("UPDATE bill_lines SET cleared_at = ?, cleared_method = 'transfer', cleared_by = ?, clear_memo = ? WHERE id = ?").run(now, me.id, text(body.memo) || null, id);
      db.prepare("INSERT INTO clearings (line_id, amount, method, cleared_at) VALUES (?,?,'transfer',?)").run(id, l.amount, now);
    })();
    audit(ctx, 'billing.clear', { target: `line:${id}`, before: { cleared: false }, after: { cleared: true, amount: l.amount, method: 'transfer' } });
    return { ok: true };
  });
  route('POST', '/api/billing/lines/:id/unclear', (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const l = getLine(id);
    const reason = text(body.reason);
    if (!reason) throw bad('取り消しの理由を入力してください');
    if (!l.cleared_at) throw new HttpError(409, 'この明細は、消し込まれていません');
    if (l.delivered_at) throw new HttpError(409, '引き渡し済みの明細は、消し込みを取り消せません。先に、引き渡しの記録を取り消してください');
    db.transaction(() => {
      db.prepare('UPDATE bill_lines SET cleared_at = NULL, cleared_method = NULL, cleared_by = NULL WHERE id = ?').run(id);
      db.prepare('UPDATE clearings SET reversed_at = ?, reverse_reason = ? WHERE line_id = ? AND reversed_at IS NULL').run(nowMs(), reason, id);
    })();
    audit(ctx, 'billing.unclear', { target: `line:${id}`, before: { cleared: true }, after: { cleared: false }, reason });
    return { ok: true };
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
    if (l.kind === 'penalty' || l.kind === 'late') throw new HttpError(409, '違約金・遅延損害金には、引き渡しはありません');
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

  // ------------------------------------------------------------ 請求書の一覧・送付済み（FR-INV-008）・ファイル
  const invoiceView = (i) => {
    const a = account(i.account_id);
    return {
      id: i.id, number: i.number, kind: i.kind, name: displayName(a), email: a.email, total: i.total, issuedOn: jst(i.issued_at),
      sentOn: i.sent_at ? jst(i.sent_at) : null, dueDate: i.due_date, draft: i.draft_state,
      // 下書きを作ってから1日たっても送付済みにならない請求書は、強調する
      stale: i.kind !== 'cash' && !i.sent_at && nowMs() - i.issued_at > DAY,
    };
  };
  route('GET', '/api/billing/invoices', (ctx) => {
    needStaff(ctx, 'admin');
    return { invoices: db.prepare('SELECT * FROM invoices ORDER BY id DESC LIMIT 1000').all().map(invoiceView) };
  });
  route('POST', '/api/billing/invoices/:id/sent', (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const i = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!i) throw new HttpError(404, '請求書が見つかりません');
    if (i.kind === 'cash') throw new HttpError(409, '当日現金の精算の請求書は、その場で渡すので、送付の記録はありません');
    if (i.sent_at) return { ok: true, dueDate: i.due_date };
    // 記録した日を「送付日」とし、支払期限はそこから数える。送付日が記録されるまで、期限はない（未払いにも自動の停止にもならない）
    const sentOn = today();
    const due = dueDate(sentOn, i.due_days, !!i.shift_holiday);
    db.prepare('UPDATE invoices SET sent_at = ?, due_date = ?, overdue_notified = 0 WHERE id = ?').run(nowMs(), due, id);
    audit(ctx, 'invoice.sent', { target: `invoice:${i.number}`, after: { sentOn, dueDate: due } });
    return { ok: true, dueDate: due };
  });
  route('POST', '/api/billing/invoices/:id/unsent', (ctx, body, id) => {
    needStaff(ctx, 'admin');
    const i = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!i?.sent_at) throw new HttpError(409, '送付済みの記録がありません');
    db.prepare('UPDATE invoices SET sent_at = NULL, due_date = NULL WHERE id = ?').run(id);
    audit(ctx, 'invoice.unsent', { target: `invoice:${i.number}`, before: { sentOn: jst(i.sent_at), dueDate: i.due_date } });
    return { ok: true };
  });
  const sendFile = (i, kind) => {
    const file = kind === 'pdf' ? i.pdf_file : i.xlsx_file;
    if (!file || !fs.existsSync(file)) throw new HttpError(404, 'ファイルが見つかりません');
    return { file: { body: fs.readFileSync(file), type: kind === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: `${i.number}.${kind}` } };
  };
  route('GET', '/api/billing/invoices/:id/pdf', (ctx, body, id) => {
    const i = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    // 主催者管理者・受付係（精算の領収書を渡す）と、その請求書の本人だけが開ける
    if (!i || !(ctx.staff && ['admin', 'reception'].includes(ctx.staff.role)) && ctx.member?.id !== i.account_id) throw new HttpError(404, '請求書が見つかりません');
    return sendFile(i, 'pdf');
  });
  route('GET', '/api/billing/invoices/:id/xlsx', (ctx, body, id) => {
    needStaff(ctx, 'admin'); // 落札者にも Excel を渡すかは未決（OQ-28）なので、主催者管理者だけ
    const i = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!i) throw new HttpError(404, '請求書が見つかりません');
    return sendFile(i, 'xlsx');
  });

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
    notifier.email(a.email, 'cancelled', '落札の解除のお知らせ', `${l.label}（${yen(l.amount)}）について、お支払いの確認が取れなかったため、落札を解除しました。\n理由: ${reason}`);
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
    const r = db.prepare('INSERT INTO bill_lines (kind, event_id, lot_id, participant_id, account_id, label, amount, parent_line_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(kind, l.event_id, l.lot_id, l.participant_id, l.account_id, `${kind === 'late' ? '遅延損害金' : '違約金'}（${l.label}）`, amount, l.id, nowMs());
    // 支払期限は、送付日の翌日から数えて7日目。休業日でも前に繰り上げない（FR-PEN-002）
    const inv = issueInvoice('penalty', [Number(r.lastInsertRowid)], { dueDays: 7, shiftHoliday: false, draft: true });
    await inv.done;
    audit(ctx, 'billing.penalty', { target: `line:${id}`, after: { kind, amount, invoice: inv.number } });
    return { ok: true, invoice: inv.number };
  });
  /** 次点: 落札者を除いた参加者のうち、その品で最も高い有効な入札をした人。停止中の会員は除く（FR-PAY-007） */
  function runnerUp(l) {
    const rows = db.prepare(`SELECT b.amount, m.id AS participant_id, m.account_id FROM bids b JOIN members m ON m.id = b.member_id
      WHERE b.lot_id = ? AND b.result = 'ACCEPTED' AND b.valid = 1 AND m.account_id IS NOT NULL AND m.account_id <> ? ORDER BY b.amount DESC, b.seq DESC`).all(l.lot_id, l.account_id);
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
    db.prepare('INSERT INTO offers (line_id, participant_id, account_id, amount, offered_at, deadline) VALUES (?,?,?,?,?,?)').run(id, next.participant_id, next.account_id, next.amount, nowMs(), deadline);
    const a = account(next.account_id);
    notifier.email(a.email, 'offer', '繰り上げ落札のご案内', `${l.label} について、落札者の解除があったため、次点のお客様に繰り上げをご案内します。\n価格: ${yen(next.amount)}（税込）\n回答期限: ${deadline}\nマイページで、承諾か辞退をお選びください。期限までにご回答がなければ、辞退とさせていただきます。`);
    audit(ctx, 'billing.offer', { target: `line:${id}`, after: { amount: next.amount, deadline } });
    return { ok: true, amount: next.amount, deadline };
  });
  route('POST', '/api/billing/lines/:id/refund', (ctx, body, id) => {
    const me = needStaff(ctx, 'admin');
    const l = getLine(id);
    const amount = Number(body.amount), on = text(body.date, 10), method = body.method === 'cash' ? 'cash' : body.method === 'transfer' ? 'transfer' : null, reason = text(body.reason);
    if (!Number.isSafeInteger(amount) || amount < 1) throw bad('返金額を、1円以上の整数で入力してください');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) throw bad('返金日を入力してください');
    if (!method) throw bad('返金の方法（現金・振込）を選んでください');
    if (!reason) throw bad('返金の理由を入力してください');
    db.prepare('INSERT INTO refunds (line_id, amount, refunded_on, method, reason, staff_id, at) VALUES (?,?,?,?,?,?,?)').run(id, amount, on, method, reason, me.id, nowMs());
    audit(ctx, 'billing.refund', { target: `line:${id}`, after: { amount, date: on, method }, reason });
    return { ok: true, lineAmount: l.amount };
  });

  // ------------------------------------------------------------ 未払いによる自動の停止（FR-AUTH-015）
  /** 支払期限を過ぎて消し込まれていない請求がある会員か。あれば、その請求書の番号を返す */
  const unpaidStmt = db.prepare(`SELECT i.number FROM bill_lines l JOIN invoices i ON i.id = l.invoice_id
    WHERE l.account_id = ? AND l.cleared_at IS NULL AND l.cancelled_at IS NULL AND i.due_date IS NOT NULL AND i.due_date < ? LIMIT 1`);
  const manualStmt = db.prepare('SELECT suspended FROM member_accounts WHERE id = ?');
  /** 停止の種類: manual（手動）/ unpaid（未払いによる自動）/ null。どちらか一方でもかかっていれば停止中（FR-AUTH-009） */
  function suspension(accountId) {
    if (manualStmt.get(accountId)?.suspended) return 'manual';
    return unpaidStmt.get(accountId, today()) ? 'unpaid' : null;
  }

  // ------------------------------------------------------------ 未引き取り（現地受け取り。FR-PAY-008）と、配送の一覧（FR-SHIP-005）
  route('GET', '/api/billing/pickup', (ctx) => {
    needStaff(ctx, 'admin', 'auctioneer', 'reception');
    const rows = db.prepare("SELECT * FROM bill_lines WHERE receive = 'pickup' AND cleared_at IS NOT NULL AND delivered_at IS NULL AND cancelled_at IS NULL AND kind IN ('lot','promote') ORDER BY cleared_at").all();
    return { today: today(), lines: rows.map(staffLineView) };
  });
  route('GET', '/api/billing/shipping.csv', (ctx) => {
    needStaff(ctx, 'admin');
    const rows = db.prepare("SELECT * FROM bill_lines WHERE receive = 'ship' AND cancelled_at IS NULL AND kind IN ('lot','promote') ORDER BY account_id, id").all();
    const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const lines = [['氏名・会社名', '配送先', '電話番号', '品', '落札額', '消し込み', '引き渡し'].map(esc).join(',')];
    for (const l of rows) {
      const a = account(l.account_id);
      lines.push([displayName(a), a.ship_to || a.address, a.phone, l.label, l.amount, l.cleared_at ? `済（${jst(l.cleared_at)}）` : '未', l.delivered_at ? '済' : '未'].map(esc).join(','));
    }
    audit(ctx, 'billing.shipping_export', { target: 'shipping.csv', after: { rows: rows.length } });
    return { file: { body: Buffer.from('﻿' + lines.join('\r\n') + '\r\n'), type: 'text/csv; charset=utf-8', name: 'shipping.csv' } };
  });

  // ------------------------------------------------------------ 手数料の集計（FR-FEE-001〜010）
  const ceilFee = (amount) => Math.ceil(amount * FEE_RATE / 100);
  function feeSummary(month) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw bad('月を、2026-12 の形で指定してください');
    const monthOf = (ms) => jst(ms).slice(0, 7);
    const all = db.prepare("SELECT c.*, l.label, l.kind, l.event_id FROM clearings c JOIN bill_lines l ON l.id = c.line_id WHERE l.kind IN ('lot','promote') ORDER BY c.cleared_at").all();
    // 対象: その月に消し込んだ明細（月の区切りは、消し込みの日。日本時間）。同じ月のうちに取り消したものは、数えない
    const counted = all.filter((c) => monthOf(c.cleared_at) === month && !(c.reversed_at && monthOf(c.reversed_at) === month));
    const base = counted.reduce((s, c) => s + c.amount, 0);
    // 差し引き: 前の月までに数えた消し込みを、この月に取り消したもの。この月に返金した明細。1件ごとに切り上げる
    const reversed = all.filter((c) => c.reversed_at && monthOf(c.reversed_at) === month && monthOf(c.cleared_at) < month);
    const refunded = db.prepare("SELECT r.*, l.label, l.amount AS line_amount FROM refunds r JOIN bill_lines l ON l.id = r.line_id WHERE substr(r.refunded_on, 1, 7) = ? AND l.kind IN ('lot','promote')").all(month);
    const deduction = reversed.reduce((s, c) => s + ceilFee(c.amount), 0) + refunded.reduce((s, r) => s + ceilFee(r.line_amount), 0);
    // 手数料 = 合計 × 5%（1円未満は切り捨て。合計に対して1回だけ丸める）
    const fee = Math.max(0, Math.floor(base * FEE_RATE / 100) - deduction);
    const minimum = Number(setting('fee_minimum')) || 0;         // 最低保証額（未決。OQ-19）
    const charge = Math.max(fee, minimum);
    const taxMode = setting('fee_tax_mode') === 'inclusive' ? 'inclusive' : 'exclusive'; // 外税 / 内税（FR-FEE-009）
    const tax = taxMode === 'exclusive' ? Math.floor(charge * 10 / 100) : 0;
    const confirm = db.prepare('SELECT * FROM fee_confirms WHERE month = ?').get(month);
    return {
      month, base, rate: FEE_RATE, deduction, fee, minimum, charge, taxMode, tax, total: charge + tax,
      confirmedOn: confirm ? jst(confirm.confirmed_at) : null,
      // 根拠になる明細ごとの一覧（FR-FEE-006）
      details: [
        ...counted.map((c) => ({ label: c.label, amount: c.amount, method: PAY[c.method], clearedOn: jst(c.cleared_at), note: '' })),
        ...reversed.map((c) => ({ label: c.label, amount: -c.amount, method: PAY[c.method], clearedOn: jst(c.cleared_at), note: `消し込みの取り消し（${jst(c.reversed_at)}）` })),
        ...refunded.map((r) => ({ label: r.label, amount: -r.line_amount, method: PAY[r.method], clearedOn: '', note: `返金（${r.refunded_on}）` })),
      ],
    };
  }
  route('GET', '/api/billing/fees', (ctx) => {
    needStaff(ctx, 'admin');
    return feeSummary(ctx.url.searchParams.get('month') ?? today().slice(0, 7));
  });
  route('POST', '/api/billing/fees/confirm', (ctx, body) => {
    const me = needStaff(ctx, 'admin');
    const s = feeSummary(String(body.month ?? ''));
    if (s.month >= today().slice(0, 7)) throw new HttpError(409, '確認済みにできるのは、締めた月（先月まで）の明細です');
    db.prepare('INSERT OR IGNORE INTO fee_confirms (month, confirmed_at, staff_id) VALUES (?,?,?)').run(s.month, nowMs(), me.id);
    audit(ctx, 'fee.confirm', { target: `month:${s.month}`, after: { total: s.total } });
    return { ok: true };
  });
  // 長く未払いのままの明細: 支払期限の翌日から30日以上、消し込みも解除もされていない（FR-FEE-007）
  route('GET', '/api/billing/long-unpaid', (ctx) => {
    needStaff(ctx, 'admin');
    const limit = addDays(today(), -30);
    const rows = db.prepare(`SELECT l.* FROM bill_lines l JOIN invoices i ON i.id = l.invoice_id
      WHERE l.cleared_at IS NULL AND l.cancelled_at IS NULL AND i.due_date IS NOT NULL AND i.due_date <= ? AND l.kind IN ('lot','promote') ORDER BY i.due_date`).all(limit);
    return { lines: rows.map(staffLineView) };
  });

  // ------------------------------------------------------------ 会員のマイページ（FR-INV-001、FR-PAY-008・009、FR-SHIP-008）
  route('GET', '/api/my/billing', (ctx) => {
    const me = needMember(ctx);
    syncLines();
    expireOffers();
    const offers = db.prepare("SELECT o.id, o.amount, o.deadline, o.state, l.label FROM offers o JOIN bill_lines l ON l.id = o.line_id WHERE o.account_id = ? ORDER BY o.id DESC").all(me.id);
    return {
      suspension: suspension(me.id),
      lines: db.prepare('SELECT * FROM bill_lines WHERE account_id = ? ORDER BY id DESC').all(me.id).map(lineView),
      offers,
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
    const r = db.prepare("INSERT INTO bill_lines (kind, event_id, lot_id, participant_id, account_id, label, amount, receive, parent_line_id, created_at) VALUES ('promote',?,?,?,?,?,?,?,?,?)")
      .run(src.event_id, src.lot_id, o.participant_id, o.account_id, `${src.label}（繰り上げ）`, o.amount, p?.receive ?? null, src.id, nowMs());
    db.prepare("UPDATE offers SET state = 'accepted', answered_at = ?, new_line_id = ? WHERE id = ?").run(nowMs(), r.lastInsertRowid, id);
    const inv = issueInvoice('promote', [Number(r.lastInsertRowid)], { dueDays: 5, shiftHoliday: true, draft: true });
    await inv.done;
    audit(ctx, 'offer.accept', { target: `offer:${id}`, after: { invoice: inv.number, amount: o.amount } });
    return { ok: true, invoice: inv.number };
  });
  // 回答期限までに回答がなければ、辞退とみなす
  function expireOffers() {
    db.prepare("UPDATE offers SET state = 'expired' WHERE state = 'open' AND deadline < ?").run(today());
  }

  // ------------------------------------------------------------ 定期の見回り（期限を過ぎた知らせ、受け取り期限の前日の知らせ）
  function sweep() {
    syncLines();
    expireOffers();
    const t = today();
    // 支払期限を過ぎた請求書: 自動で停止になる。理由を、メールで知らせる（マイページにも出る。AC-FR-AUTH-015-1）
    const overdue = db.prepare(`SELECT DISTINCT i.* FROM invoices i JOIN bill_lines l ON l.invoice_id = i.id
      WHERE i.due_date IS NOT NULL AND i.due_date < ? AND i.overdue_notified = 0 AND l.cleared_at IS NULL AND l.cancelled_at IS NULL`).all(t);
    for (const i of overdue) {
      const a = account(i.account_id);
      notifier.email(a.email, 'overdue', 'お支払いの確認が取れていません', `請求書 ${i.number}（${yen(i.total)}）のお支払期限（${i.due_date}）を過ぎました。\nお支払いの確認が取れるまで、競りへの参加を停止しています。`);
      db.prepare('UPDATE invoices SET overdue_notified = 1 WHERE id = ?').run(i.id);
    }
    // 現地受け取りの期限の前日に、落札者に知らせる
    const soon = db.prepare("SELECT l.* FROM bill_lines l WHERE l.receive = 'pickup' AND l.cleared_at IS NOT NULL AND l.delivered_at IS NULL AND l.cancelled_at IS NULL AND l.kind IN ('lot','promote') AND NOT EXISTS (SELECT 1 FROM pickup_notices n WHERE n.line_id = l.id)").all();
    let pickup = 0;
    for (const l of soon) {
      const by = addDays(jst(l.cleared_at), 7);
      if (addDays(by, -1) !== t) continue;
      const a = account(l.account_id);
      notifier.email(a.email, 'pickup', '受け取り期限のお知らせ', `${l.label} の受け取り期限は、明日（${by}）までです。会場の営業時間内に、お受け取りください。`);
      db.prepare('INSERT INTO pickup_notices (line_id, at) VALUES (?, ?)').run(l.id, nowMs());
      pickup++;
    }
    return { overdue: overdue.length, pickup };
  }

  return { syncLines, onEventEnd, suspension, sweep, feeSummary };
}
