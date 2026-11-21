// MVP の 6: 請求書の自動発行、入金の消し込み、引き渡し、未払い・解除・繰り上げ・違約金・返金、未引き取り、手数料の集計。
// 決済はしない（決定）。現金も振込も、システムの外で受け取り、ここには「消し込み」だけを記録する。
// 送料は一切扱わない（FR-SHIP-001）。請求書に載せるのは、落札代金と、違約金・遅延損害金だけ。
import fs from 'node:fs';
import path from 'node:path';
import { makeInvoiceFiles } from './invoice-files.js';
import { Worker } from 'node:worker_threads';
import { migrate } from '../migrate.js';
import { jpDay, compose, subjectOf, kv, signature } from './mails.js';
import { createPickup } from './pickup.js';
import { createInvoiceRoutes } from './invoice-routes.js';
import { createClearing } from './clearing.js';
import { createUnpaid } from './unpaid.js';
import { createBillingMypage } from './billing-mypage.js';
import { createFees } from './fees.js';
import { RECV, addDays, csvCell } from './shared.js';
export { addDays, csvCell };

export const BILLING_SCHEMA = `
-- 明細: 落札した品1つにつき1行（FR-INV-003）。違約金・遅延損害金・繰り上げも、同じ形の行として持つ
CREATE TABLE IF NOT EXISTS bill_lines (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('lot','promote','penalty','late','shipping')),   -- shipping: 送料（金額は、主催者管理者があとから手で入れる）
  event_id INTEGER NOT NULL, lot_id INTEGER, participant_id INTEGER, account_id INTEGER NOT NULL,
  label TEXT NOT NULL,                     -- 請求書に載せる名前（No. と品名）
  amount INTEGER NOT NULL CHECK (amount > 0),   -- 税込。落札の明細では、落札額
  premium INTEGER NOT NULL DEFAULT 0,      -- 買歩銭（落札額に対する割合で、落札者が払う手数料。発注者の決定で 10%）
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
CREATE INDEX IF NOT EXISTS bill_lines_account ON bill_lines(account_id);
CREATE INDEX IF NOT EXISTS bill_lines_invoice ON bill_lines(invoice_id);
`;


export function createBilling({ db, config, nowMs, audit, notifier, setting, route, needStaff, needMember, HttpError, bad }) {
  // 以前の版のデータベース: 明細の種類に「送料」を足すには、表を作り直すしかない（SQLite の制約）。行の id は変えない
  const oldLines = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bill_lines'").get();
  if (oldLines && !oldLines.sql.includes("'shipping'")) {
    db.transaction(() => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('bill_lines')").all().map((c) => c.name).join(', ');
      db.exec('DROP INDEX IF EXISTS bill_lines_lot; ALTER TABLE bill_lines RENAME TO bill_lines_old;');
      db.exec(BILLING_SCHEMA);
      db.exec(`INSERT INTO bill_lines (${cols}) SELECT ${cols} FROM bill_lines_old; DROP TABLE bill_lines_old;`);
    })();
  }
  db.exec(BILLING_SCHEMA);
  // 形の変更は、番号を付けて1回ずつ（migrate.js）
  migrate(db, 'billing', [
    { v: 1, name: '無効にした領収書（取り消した日と、取り消す前の明細）', up: (d) => { d.exec('ALTER TABLE invoices ADD COLUMN voided_at REAL'); d.exec('ALTER TABLE invoices ADD COLUMN void_lines TEXT'); } },
    { v: 2, name: '配送のメモ（伝票番号など）', up: (d) => d.exec('ALTER TABLE bill_lines ADD COLUMN ship_memo TEXT') },
    { v: 3, name: '配送: 運送会社・伝票番号・発送のお知らせを送った時刻', up: (d) => { d.exec('ALTER TABLE bill_lines ADD COLUMN ship_carrier TEXT'); d.exec('ALTER TABLE bill_lines ADD COLUMN ship_tracking TEXT'); d.exec('ALTER TABLE bill_lines ADD COLUMN ship_notified_at REAL'); } },
  ], { nowMs });
  if (!db.prepare("SELECT 1 FROM pragma_table_info('bill_lines') WHERE name = 'premium'").get()) db.exec('ALTER TABLE bill_lines ADD COLUMN premium INTEGER NOT NULL DEFAULT 0');
  // 繰り上げの打診のときの買歩銭（打診のあとに割合を変えても、案内した金額のまま請求する。本番運用の評価 C）
  if (!db.prepare("SELECT 1 FROM pragma_table_info('offers') WHERE name = 'premium'").get()) db.exec('ALTER TABLE offers ADD COLUMN premium INTEGER');
  const invoiceDir = path.join(config.dataDir, 'invoices');
  fs.mkdirSync(invoiceDir, { recursive: true });
  const jst = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10); // 日本時間の日付（DATA-006）
  const today = () => jst(nowMs());
  const yen = (n) => '¥' + Number(n).toLocaleString('ja-JP');
  const text = (v, max = 500) => String(v ?? '').trim().slice(0, max);
  const getLine = (id) => { const l = db.prepare('SELECT * FROM bill_lines WHERE id = ?').get(id); if (!l) throw new HttpError(404, '明細が見つかりません'); return l; };
  const account = (id) => db.prepare('SELECT * FROM member_accounts WHERE id = ?').get(id);
  const displayName = (a) => (a.kind === 'b2b' ? `${a.company}　${a.contact_name}` : a.name);

  // ------------------------------------------------------------ 印鑑の画像（請求書に押す。主催者設定で登録する）
  // 印影は、悪用されると困るものなので、ソースコードには入れない。データの置き場（data/brand）にだけ置く
  const brandDir = path.join(config.dataDir, 'brand');
  const sealFile = () => ['seal.png', 'seal.jpg'].map((f) => path.join(brandDir, f)).find((f) => fs.existsSync(f)) ?? null;
  // ---- 原本の発行者の情報（発注者の指示: 請求書の会社情報を、原本と全く同じにする。報告書 72 章）
  // 値は、公開のリポジトリには入れない。GitHub の秘密の値（INVOICE_ORIGINAL）を、配るときにデータの保存先の brand/original.json に置き、
  // 起動のたびに、ここで設定と印鑑に反映する。この値がある項目は、管理画面からは変えられない（変えても、原本の値に戻る）
  const ORIGINAL_KEYS = ['org_name', 'org_address', 'org_tel', 'org_email', 'invoice_reg_no', 'bank_account'];
  const originalFile = path.join(brandDir, 'original.json');
  function readOriginal() {
    if (!fs.existsSync(originalFile)) return null;
    try {
      const o = JSON.parse(fs.readFileSync(originalFile, 'utf8'));
      return o && typeof o === 'object' ? o : null;
    } catch (e) { console.error('[original] brand/original.json を読めません:', e.message); return null; }
  }
  const original = readOriginal();
  /** 原本の値で固定している設定の名前 */
  const fixedKeys = () => (original ? ORIGINAL_KEYS.filter((k) => typeof original[k] === 'string' && original[k] !== '') : []);
  // 原本の印鑑の画像は、別のファイル（brand/original-seal.jpg か .png）。配るときに、秘密の値から作って置く（画像はそのまま。変換しない）
  const originalSeal = ['original-seal.png', 'original-seal.jpg'].map((f) => path.join(brandDir, f)).find((f) => fs.existsSync(f)) ?? null;
  const sealFixed = () => !!originalSeal;
  if (original) {
    for (const k of fixedKeys()) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, original[k].replace(/\r\n/g, '\n'));
  }
  if (originalSeal) {
    const buf = fs.readFileSync(originalSeal);
    const png = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if (png || jpg) {
      const name = png ? 'seal.png' : 'seal.jpg';
      for (const f of ['seal.png', 'seal.jpg']) if (f !== name) fs.rmSync(path.join(brandDir, f), { force: true });
      const target = path.join(brandDir, name);
      if (!fs.existsSync(target) || !fs.readFileSync(target).equals(buf)) fs.writeFileSync(target, buf, { mode: 0o600 });
    } else console.error('[original] 原本の印鑑の画像が、PNG でも JPEG でもありません');
  }

  route('GET', '/api/settings/seal', (ctx) => {
    needStaff(ctx, 'admin');
    const file = sealFile();
    if (!file) throw new HttpError(404, '印鑑の画像は、登録されていません');
    return { image: { body: fs.readFileSync(file), type: file.endsWith('.png') ? 'image/png' : 'image/jpeg' } };
  });
  route('POST', '/api/settings/seal', (ctx, body) => {
    needStaff(ctx, 'admin');
    if (sealFixed()) throw new HttpError(409, '印鑑は、原本の画像で固定しています（配るときの設定で変えます）');
    fs.mkdirSync(brandDir, { recursive: true });
    for (const f of ['seal.png', 'seal.jpg']) fs.rmSync(path.join(brandDir, f), { force: true });
    if (!body.image) { audit(ctx, 'settings.seal', { target: 'seal', after: { registered: false } }); return { ok: true, registered: false }; }
    const buf = Buffer.from(String(body.image), 'base64');
    // 画像の種類は、中身の先頭で確かめる（PNG か JPEG だけ）
    const png = buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if (!png && !jpg) throw bad('印鑑の画像は、PNG か JPEG にしてください');
    fs.writeFileSync(path.join(brandDir, png ? 'seal.png' : 'seal.jpg'), buf, { mode: 0o600 });
    audit(ctx, 'settings.seal', { target: 'seal', after: { registered: true, bytes: buf.length } });
    return { ok: true, registered: true };
  });

  // ------------------------------------------------------------ 買歩銭（発注者の決定: 落札額の 10%）
  /** 買歩銭の割合（%）。主催者設定で変えられる。変えても、すでに作った明細の金額は変わらない */
  const premiumRate = () => { const r = Number(setting('buyer_premium_rate')); return Number.isFinite(r) && r >= 0 && r <= 100 ? r : 10; };
  /** 1つの落札についての買歩銭。1円未満は切り捨てる【前提】 */
  const premiumOf = (amount) => Math.floor(amount * premiumRate() / 100);
  /** 繰り上げの打診で案内した買歩銭（前の版で作った打診には持っていないので、いまの割合で数える） */
  const offerPremiumOf = (o) => o.premium ?? premiumOf(o.amount);
  /**
   * 請求書の、いまの金額。解除した明細は除く（解除しても、発行したときの合計 invoices.total は、記録として変えない。本番運用の評価 C）
   * due: 払ってもらう金額 / paid: 消し込んだ金額 / cancelled: 解除した明細の数 / lines: 明細の数
   */
  function invoiceAmounts(i) {
    const lines = db.prepare('SELECT * FROM bill_lines WHERE invoice_id = ?').all(i.id);
    const live = lines.filter((l) => !l.cancelled_at);
    return { due: live.reduce((s, l) => s + payable(l), 0), paid: live.filter((l) => l.cleared_at).reduce((s, l) => s + payable(l), 0), cancelled: lines.length - live.length, lines: lines.length };
  }
  /** 一覧の件数（?limit=。既定の件数から、最大 50,000 件まで） */
  const listLimit = (ctx, def) => Math.min(50000, Math.max(def, Math.floor(Number(ctx.url.searchParams.get('limit')) || def)));
  /** 落札者が払う金額（落札額＋買歩銭） */
  const payable = (l) => l.amount + (l.premium ?? 0);

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
      const premium = premiumOf(r.amount);
      db.prepare('INSERT INTO bill_lines (kind, event_id, lot_id, participant_id, account_id, label, amount, premium, receive, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('lot', r.event_id, r.lot_id, r.participant_id, r.account_id, `No.${r.lot_no} ${r.title}`, r.amount, premium, r.receive, nowMs());
      const a = account(r.account_id);
      // 落札者に、メールでも知らせる（画面には、締めの時点で出ている）
      notifier.email(a.email, 'won', subjectOf(`落札しました　No.${r.lot_no} ${r.title}`), compose(setting, { name: displayName(a), lines: [
        `No.${r.lot_no} ${r.title} を、落札しました。`,
        '',
        ...kv([
          ['落札額', `${yen(r.amount)}（税込）`],
          ['買歩銭', `${yen(premium)}（落札額の${premiumRate()}%）`],
          ['お支払いの金額', yen(r.amount + premium)],
          ['お受け取り', { ship: '配送（送料は別にかかります）', pickup: '現地受け取り' }[r.receive]],
        ]),
        '',
        '当日、会場で精算しなかった品は、開催の終了後に、銀行振込の請求書をお送りします。',
        'お支払いと受け取りの状況は、マイページでいつでも確かめられます。',
      ] }));
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
  function issueInvoice(kind, lineIds, { dueDays = null, draft = false } = {}) {
    const lines = lineIds.map(getLine);
    const first = lines[0];
    const total = lines.reduce((s, l) => s + payable(l), 0); // 落札額＋買歩銭
    const receiveNote = [...new Set(lines.map((l) => RECV[l.receive]).filter(Boolean))].join('・');
    const info = db.transaction(() => {
      const number = nextNumber();
      // 支払期限は、発行日の5日後（違約金などは7日後）の日付（発注者の指示。請求書には、この日付だけを書く）
      const due = dueDays === null ? null : addDays(today(), dueDays);
      const r = db.prepare('INSERT INTO invoices (number, kind, account_id, event_id, issued_at, total, receive_note, due_days, shift_holiday, due_date) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(number, kind, first.account_id, first.event_id, nowMs(), total, receiveNote, dueDays, 0, due);
      for (const l of lines) db.prepare('UPDATE bill_lines SET invoice_id = ? WHERE id = ?').run(r.lastInsertRowid, l.id);
      return { id: Number(r.lastInsertRowid), number };
    })();
    return renderInvoice(info.id, { draft });
  }
  /**
   * 請求書のファイル（PDF・Excel）を、いまの明細から作る。送料を足したり直したりしたときは、作り直す
   * （作り直せるのは、送付済みにする前だけ。送ったあとの請求書は、変えない）。
   */
  /**
   * 請求メールの下書きの件名と本文（発注者の指示で見直した）。開いてすぐ分かるように、上から
   * 「いつの、何の請求か」→ ご請求額とお支払い期限 → 内訳 → お振込先 → 受け取り → 連絡先 の順に書く。
   * 金額・期限・振込先は、添付の請求書（PDF）と同じ値。PDF に載せていない注記（依頼人名・振込手数料・受け取り方法）は、ここに書く。
   */
  function invoiceMail(inv, lines, shipping, a, org) {
    const day = jpDay;
    const ev = db.prepare('SELECT starts_at FROM events WHERE id = ?').get(inv.event_id);
    const evDay = ev ? day(ev.starts_at.slice(0, 10)) : '';
    const due = inv.due_date ? day(inv.due_date) : '';
    const what = inv.kind === 'penalty' ? '落札の解除などに伴うご請求'
      : inv.kind === 'promote' ? '繰り上げ落札をご承諾いただいた品のご請求'
      : `${evDay}の競りで落札された品のご請求`;
    const subject = `【令和の競り】${inv.kind === 'penalty' ? '違約金などの' : inv.kind === 'promote' ? '繰り上げ落札の' : `${evDay}の`}ご請求　${yen(inv.total)}（お支払い期限 ${due}）`;
    const RECV = { pickup: '現地受け取り', ship: '配送' };
    const premiumTotal = lines.reduce((t, l) => t + (l.premium ?? 0), 0);
    const tax = inv.kind === 'penalty' ? null : Math.floor(inv.total * 10 / 110);
    const items = [
      ...lines.map((l) => `・${l.label}　${yen(l.amount)}${l.receive && RECV[l.receive] && !['penalty', 'late'].includes(l.kind) ? `（${RECV[l.receive]}）` : ''}`),
      ...(premiumTotal ? [`・買歩銭（落札額の${premiumRate()}%）　${yen(premiumTotal)}`] : []),
      ...shipping.map((l) => `・${l.label}　${yen(l.amount)}`),
    ];
    const ships = lines.some((l) => l.receive === 'ship'), picks = lines.some((l) => l.receive === 'pickup');
    const receive = [
      // 発送の時期は、決まりがないので書かない。送料が、この請求に入っているかどうかだけを書く
      ...(ships ? [shipping.length ? '・配送の品の送料は、このご請求に含まれています。' : '・配送の品の送料は、このご請求には含まれていません。'] : []),
      ...(picks ? ['・現地受け取りの品は、ご入金の確認から7日以内に、会場でお受け取りください。'] : []),
    ];
    const body = [
      `${displayName(a)} 様`,
      '',
      'いつも令和の競りをご利用いただき、ありがとうございます。',
      `${what}をお送りします。請求書（PDF）を添付しています。`,
      '',
      `ご請求額　　　${yen(inv.total)}（税込）`,
      `お支払い期限　${due}`,
      `請求書番号　　${inv.number}`,
      '',
      '【内訳】',
      ...items,
      `合計　${yen(inv.total)}${tax !== null ? `（うち消費税 ${yen(tax)}）` : '（消費税の対象外）'}`,
      '',
      '【お振込先】',
      org.bank_account || '（振込先は、添付の請求書をご覧ください）',
      `・ご依頼人名の前に、請求書番号「${inv.number}」を入れてください。`,
      '・振込手数料は、お客様のご負担となります。',
      ...(receive.length ? ['', '【お受け取り】', ...receive] : []),
      '',
      'ご不明な点は、このメールにご返信ください。',
      '',
      ...signature(setting),
    ].join('\n');
    return { subject, body };
  }

  // 請求書のファイルは、別のスレッドで作る（競りの最中の精算で、入札の受け付けを止めない。報告書 118 章）。
  // スレッドを使えないとき・途中で落ちたときは、これまでどおり、同じスレッドで作る
  // 作っている最中のもの。止まる前（と、テストの後始末の前）に、書き終わりを待てるようにする
  const pendingFiles = new Set();
  const track = (p) => { const q = Promise.resolve(p).catch(() => {}).finally(() => pendingFiles.delete(q)); pendingFiles.add(q); return p; };
  const filesIdle = async () => { while (pendingFiles.size) await Promise.all([...pendingFiles]); };
  let worker = null, jobSeq = 0;
  const jobs = new Map();
  function filesWorker() {
    if (worker || config.invoiceWorker === false) return worker;
    try {
      worker = new Worker(new URL('./invoice-worker.js', import.meta.url));
      worker.unref(); // 待ちが無いときは、プロセスの終了を妨げない
      worker.on('message', ({ id, ok, error }) => { const j = jobs.get(id); if (!j) return; jobs.delete(id); if (!jobs.size) worker?.unref(); ok ? j.resolve() : j.reject(new Error(error)); });
      const lost = (err) => { worker = null; for (const [id, j] of jobs) { jobs.delete(id); j.retry(err); } };
      worker.on('error', lost);
      worker.on('exit', () => lost(new Error('請求書を作るスレッドが止まりました')));
    } catch { worker = null; }
    return worker;
  }
  function makeFiles(args) {
    const pdf = path.join(args.dir, `${args.invoice.number}${args.receipt ? '-receipt' : ''}.pdf`), xlsx = path.join(args.dir, `${args.invoice.number}.xlsx`);
    const w = filesWorker();
    if (!w) return makeInvoiceFiles(args);
    const done = new Promise((resolve, reject) => {
      const id = ++jobSeq;
      // スレッドが落ちたら、同じスレッドで作り直す（請求書を作れないままにしない）
      jobs.set(id, { resolve, reject, retry: () => makeInvoiceFiles(args).done.then(resolve, reject) });
      w.ref();
      w.postMessage({ id, args });
    });
    return { pdf, xlsx, done };
  }

  // 同じ請求書の作り直しは、1つずつ行う（送料の更新が重なると、同じファイルに同時に書いて PDF が壊れていた。本番運用の評価 B3）
  const rendering = new Map();
  function renderInvoice(invoiceId, opts = {}) {
    const prev = rendering.get(invoiceId) ?? Promise.resolve();
    let result;
    const done = prev.catch(() => {}).then(() => { result = renderInvoiceNow(invoiceId, opts); return result.done; });
    rendering.set(invoiceId, done.catch(() => {}));
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    return { ...inv, done };
  }
  /** 請求書・領収書のファイルに書く中身（発行者・宛先・件名・印鑑） */
  const fileArgs = (inv, lines, shipping, a, org) => ({
    dir: invoiceDir, invoice: inv, lines, shipping, org, to: { name: displayName(a), address: a.kind === 'b2b' && a.billing ? a.billing : a.address },
    seal: sealFile(),
    premium: { total: lines.reduce((s, l) => s + (l.premium ?? 0), 0), rate: premiumRate() },
    issuedOn: jst(inv.issued_at), paidOn: inv.kind === 'cash' ? jst(inv.issued_at) : null,
    // 件名: 開催日と「令和の競り」だけ（発注者の指示。例: 12.7 令和の競り）
    subject: (() => { const e = db.prepare('SELECT starts_at FROM events WHERE id = ?').get(inv.event_id); return e ? `${Number(e.starts_at.slice(5, 7))}.${Number(e.starts_at.slice(8, 10))} 令和の競り` : '令和の競り'; })(),
  });
  /**
   * 領収書（振込などで払った人。発注者の決定。報告書 123 章）。請求書の明細（解除したものを除く）が、すべて消し込み済みのときだけ作れる。
   * 当日現金の精算は、請求書が領収書を兼ねるので、作らない。開くたびに、いまの消し込みの内容で作り直す
   */
  const receiptJobs = new Map(); // 同じ領収書を、同時に2つ書かない
  function renderReceipt(inv) {
    const running = receiptJobs.get(inv.id);
    if (running) return running;
    if (inv.kind === 'cash') throw new HttpError(409, '当日現金の精算は、請求書が領収書を兼ねています');
    const all = db.prepare('SELECT * FROM bill_lines WHERE invoice_id = ? AND cancelled_at IS NULL ORDER BY id').all(inv.id);
    if (!all.length || all.some((l) => !l.cleared_at)) throw new HttpError(409, 'お支払いの確認が済んでいないので、領収書は、まだ発行できません');
    const lines = all.filter((l) => l.kind !== 'shipping'), shipping = all.filter((l) => l.kind === 'shipping');
    const a = account(inv.account_id);
    const org = Object.fromEntries(['org_name', 'org_address', 'org_tel', 'org_email', 'invoice_reg_no', 'bank_account'].map((k) => [k, setting(k)]));
    const last = all.reduce((x, l) => (l.cleared_at > x.cleared_at ? l : x));
    // 領収の日は、入金の日（消し込みに記録した日）のうち、いちばん新しい日
    const files = makeFiles({ ...fileArgs(inv, lines, shipping, a, org), receipt: { paidOn: jst(last.cleared_at), method: all.every((l) => l.cleared_method === 'cash') ? 'cash' : 'transfer', total: all.reduce((s, l) => s + payable(l), 0) } });
    track(files.done);
    receiptJobs.set(inv.id, files);
    files.done.catch(() => {}).finally(() => receiptJobs.delete(inv.id));
    return files;
  }
  function renderInvoiceNow(invoiceId, { draft = false } = {}) {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    // 無効にした領収書（精算をすべて取り消したもの）は、取り消す前の明細で作り、「無効」の印を入れる（発注者の決定。報告書 123 章）
    const all = inv.voided_at ? JSON.parse(inv.void_lines || '[]') : db.prepare('SELECT * FROM bill_lines WHERE invoice_id = ? ORDER BY id').all(invoiceId);
    const lines = all.filter((l) => l.kind !== 'shipping'), shipping = all.filter((l) => l.kind === 'shipping');
    const a = account(inv.account_id);
    const org = Object.fromEntries(['org_name', 'org_address', 'org_tel', 'org_email', 'invoice_reg_no', 'bank_account'].map((k) => [k, setting(k)]));
    const files = makeFiles({ ...fileArgs(inv, lines, shipping, a, org), voidedOn: inv.voided_at ? jst(inv.voided_at) : null });
    db.prepare('UPDATE invoices SET pdf_file = ?, xlsx_file = ? WHERE id = ?').run(files.pdf, files.xlsx, inv.id);
    // 送付用のメールの下書き（FR-INV-007）。送信は、利用会社の担当者が自分で行う。当日現金の精算では作らない
    if (draft) {
      const mail = invoiceMail(inv, lines, shipping, a, org);
      track(files.done.then(() => notifier.draft(a.email, mail.subject, mail.body, [files.pdf]))
        .then((ok) => db.prepare('UPDATE invoices SET draft_state = ? WHERE id = ?').run(ok ? 'made' : 'failed', inv.id))
        .catch(() => db.prepare("UPDATE invoices SET draft_state = 'failed' WHERE id = ?").run(inv.id)));
    }
    track(files.done);
    return { ...inv, done: files.done };
  }

  // ------------------------------------------------------------ 送料（発注者の決定: 請求書に送料の行を載せる。金額は、あとから手で入れる）
  // 配送の落札者について、主催者管理者が金額と内容（運送会社・大きさなど）を入れる。まだ送っていない請求書があれば、
  // その請求書に行を足して作り直す。なければ、送料だけの請求書を新しく出す。送料には、買歩銭も、開発・運営者の手数料もかからない
  route('POST', '/api/billing/shipping', async (ctx, body) => {
    needStaff(ctx, 'admin');
    const accountId = Number(body.accountId), eventId = Number(body.eventId), amount = Number(body.amount);
    const label = `【送料】${text(body.label, 80)}`.trim();
    if (!account(accountId)) throw new HttpError(404, '落札者が見つかりません');
    if (!Number.isSafeInteger(amount) || amount < 0) throw bad('送料を、0円以上の整数で入力してください（0円で、送料の行を消します）');
    const open = db.prepare("SELECT * FROM invoices WHERE account_id = ? AND event_id = ? AND kind IN ('transfer','promote') AND sent_at IS NULL ORDER BY id DESC LIMIT 1").get(accountId, eventId);
    const existing = open && db.prepare("SELECT * FROM bill_lines WHERE invoice_id = ? AND kind = 'shipping'").get(open.id);
    if (existing?.cleared_at) throw new HttpError(409, 'この請求書の送料は、消し込み済みです。変えるには、先に消し込みを取り消してください');
    let inv;
    if (open) {
      db.transaction(() => {
        if (existing && amount === 0) db.prepare('DELETE FROM bill_lines WHERE id = ?').run(existing.id);
        else if (existing) db.prepare('UPDATE bill_lines SET amount = ?, label = ? WHERE id = ?').run(amount, label, existing.id);
        else if (amount > 0) db.prepare("INSERT INTO bill_lines (kind, event_id, account_id, label, amount, invoice_id, created_at) VALUES ('shipping',?,?,?,?,?,?)").run(eventId, accountId, label, amount, open.id, nowMs());
        const sum = db.prepare('SELECT COALESCE(SUM(amount + premium), 0) AS n FROM bill_lines WHERE invoice_id = ?').get(open.id).n;
        // 作り直す請求書は、今日の発行として、支払期限も決め直す（送料を足した日に、すでに期限を過ぎていることがないように。本番運用の評価 B2）
        db.prepare('UPDATE invoices SET total = ?, issued_at = ?, due_date = ? WHERE id = ?').run(sum, nowMs(), open.due_days ? addDays(today(), open.due_days) : open.due_date, open.id);
      })();
      inv = renderInvoice(open.id, { draft: true }); // 請求書と下書きを、送料入りで作り直す
    } else {
      if (amount === 0) throw new HttpError(409, '消せる送料の行がありません');
      const r = db.prepare("INSERT INTO bill_lines (kind, event_id, account_id, label, amount, created_at) VALUES ('shipping',?,?,?,?,?)").run(eventId, accountId, label, amount, nowMs());
      inv = issueInvoice('transfer', [Number(r.lastInsertRowid)], { dueDays: 5, draft: true });
    }
    await inv.done;
    audit(ctx, 'billing.shipping', { target: `invoice:${inv.number}`, after: { amount, label } });
    return { ok: true, invoice: { id: inv.id, number: inv.number, total: db.prepare('SELECT total FROM invoices WHERE id = ?').get(inv.id).total } };
  });

  /** 開催終了（FR-EVT-003）: まだ精算していない明細を、落札者ごとに1通の振込の請求書にまとめる（FR-INV-004） */
  function onEventEnd(eventId, ctx) {
    syncLines();
    const groups = db.prepare("SELECT account_id, GROUP_CONCAT(id) AS ids FROM bill_lines WHERE event_id = ? AND kind = 'lot' AND invoice_id IS NULL AND cancelled_at IS NULL GROUP BY account_id").all(eventId);
    const made = groups.map((g) => issueInvoice('transfer', g.ids.split(',').map(Number), { dueDays: 5, draft: true }));
    if (made.length) audit(ctx, 'invoice.issue_on_end', { target: `event:${eventId}`, after: { invoices: made.map((i) => i.number) } });
    return made;
  }

  // ------------------------------------------------------------ 画面に出す形
  function lineView(l) {
    const inv = l.invoice_id ? db.prepare('SELECT * FROM invoices WHERE id = ?').get(l.invoice_id) : null;
    // 期限切れは、送った請求書だけ（送っていない請求書で、停止・督促・解除まで進まないように。本番運用の評価 B2）
    const overdue = !!inv?.sent_at && !!inv?.due_date && inv.due_date < today() && !l.cleared_at && !l.cancelled_at;
    // 現地受け取りの期限: 消し込みの日の翌日から数えて7日目まで（FR-PAY-008）
    const pickupBy = l.receive === 'pickup' && l.cleared_at && l.kind !== 'penalty' && l.kind !== 'late' ? addDays(jst(l.cleared_at), 7) : null;
    return {
      id: l.id, kind: l.kind, label: l.label, amount: l.amount, premium: l.premium ?? 0, payable: payable(l), receive: l.receive, eventId: l.event_id,
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
  /** 請求の一覧で選ぶ開催。明細のある開催を、新しい順に。?event=番号 / all / なし（いちばん新しい開催） */
  function pickEvent(ctx) {
    const events = db.prepare(`SELECT e.id, e.title, substr(e.starts_at, 1, 10) AS date, COUNT(l.id) AS lines,
      SUM(CASE WHEN l.cleared_at IS NULL AND l.cancelled_at IS NULL THEN 1 ELSE 0 END) AS open
      FROM events e JOIN bill_lines l ON l.event_id = e.id GROUP BY e.id ORDER BY e.starts_at DESC, e.id DESC`).all();
    const want = ctx.url.searchParams.get('event');
    const id = want === 'all' ? null : events.find((e) => String(e.id) === want)?.id ?? events[0]?.id ?? null;
    return { events, id };
  }
  route('GET', '/api/billing/lines', (ctx) => {
    needStaff(ctx, 'admin', 'reception');
    syncLines();
    // 新しい順に limit 件。ただし、まだ入金のない明細は、古くても必ず出す（一覧の上限で、未払いが見えなくならないように。本番運用の評価 C）
    const limit = listLimit(ctx, 1000);
    // 開催ごとに分けて出す（発注者の決定。報告書 124 章）。指定が無ければ、明細のある、いちばん新しい開催。event=all で、すべての開催
    const picked = pickEvent(ctx);
    if (picked.id !== null) {
      const rows = db.prepare('SELECT * FROM bill_lines WHERE event_id = ? ORDER BY account_id, id').all(picked.id);
      return { today: today(), lines: rows.map(staffLineView), limit, more: false, events: picked.events, event: picked.id };
    }
    const rows = db.prepare(`SELECT * FROM bill_lines WHERE id >= coalesce((SELECT id FROM bill_lines ORDER BY id DESC LIMIT 1 OFFSET ?), 0)
      OR (cleared_at IS NULL AND cancelled_at IS NULL) ORDER BY id DESC`).all(limit - 1);
    return { today: today(), lines: rows.map(staffLineView), limit, more: db.prepare('SELECT COUNT(*) AS n FROM bill_lines').get().n > rows.length, events: picked.events, event: null };
  });

  // ------------------------------------------------------------ 当日現金の精算（clearing.js）
  createClearing({ HttpError, audit, bad, db, getLine, issueInvoice, renderInvoice, needStaff, nowMs, payable, route, syncLines, text, today, yen });

  // ------------------------------------------------------------ 請求書の一覧・送付済み（invoice-routes.js）
  createInvoiceRoutes({ HttpError, account, audit, db, renderReceipt, pickEvent, displayName, invoiceAmounts, invoiceMail, jst, listLimit, needStaff, nowMs, renderInvoice, route, setting, today });

  // ------------------------------------------------------------ 未払い: 督促・解除・違約金・繰り上げ・返金（unpaid.js）
  createUnpaid({ HttpError, account, audit, bad, db, displayName, getLine, issueInvoice, jst, lineView, needStaff, notifier, nowMs, payable, premiumOf, premiumRate, route, setting, suspension, text, today, yen });

  // ------------------------------------------------------------ 未払いによる自動の停止（FR-AUTH-015）
  /** 支払期限を過ぎて消し込まれていない請求がある会員か。あれば、その請求書の番号を返す */
  const unpaidStmt = db.prepare(`SELECT i.number FROM bill_lines l JOIN invoices i ON i.id = l.invoice_id
    WHERE l.account_id = ? AND l.cleared_at IS NULL AND l.cancelled_at IS NULL AND i.sent_at IS NOT NULL AND i.due_date IS NOT NULL AND i.due_date < ? LIMIT 1`);
  const manualStmt = db.prepare('SELECT suspended FROM member_accounts WHERE id = ?');
  /** 停止の種類: manual（手動）/ unpaid（未払いによる自動）/ null。どちらか一方でもかかっていれば停止中（FR-AUTH-009） */
  function suspension(accountId) {
    if (manualStmt.get(accountId)?.suspended) return 'manual';
    return unpaidStmt.get(accountId, today()) ? 'unpaid' : null;
  }

  // ------------------------------------------------------------ 未引き取り（pickup.js）
  createPickup({ account, audit, bad, db, displayName, invoiceAmounts, jst, needStaff, route, staffLineView, today, nowMs, getLine, notifier, setting, payable });

  // ------------------------------------------------------------ 手数料の集計（fees.js）
  const { feeSummary } = createFees({ HttpError, audit, bad, db, jst, needStaff, nowMs, route, setting, staffLineView, today });

  // ------------------------------------------------------------ 会員のマイページ（billing-mypage.js）
  const { expireOffers } = createBillingMypage({ HttpError, audit, bad, db, getLine, invoiceAmounts, issueInvoice, jst, lineView, needMember, nowMs, offerPremiumOf, payable, route, setting, suspension, syncLines, today });

  // ------------------------------------------------------------ 定期の見回り（期限を過ぎた知らせ、受け取り期限の前日の知らせ）
  function sweep() {
    syncLines();
    expireOffers();
    const t = today();
    // 支払期限を過ぎた請求書: 自動で停止になる。理由を、メールで知らせる（マイページにも出る。AC-FR-AUTH-015-1）
    const overdue = db.prepare(`SELECT DISTINCT i.* FROM invoices i JOIN bill_lines l ON l.invoice_id = i.id
      WHERE i.sent_at IS NOT NULL AND i.due_date IS NOT NULL AND i.due_date < ? AND i.overdue_notified = 0 AND l.cleared_at IS NULL AND l.cancelled_at IS NULL`).all(t);
    for (const i of overdue) {
      const a = account(i.account_id);
      const bank = setting('bank_account');
      notifier.email(a.email, 'overdue', subjectOf(`お支払いの確認が取れていません（請求書 ${i.number}）`), compose(setting, { name: displayName(a), lines: [
        `請求書 ${i.number} のお支払い期限（${jpDay(i.due_date)}）を過ぎましたが、まだお支払いの確認が取れていません。`,
        '',
        ...kv([['ご請求額', yen(invoiceAmounts(i).due)], ['請求書番号', i.number]]), // 解除した明細を除いた金額
        '',
        'お支払いの確認が取れるまで、競りへの参加を停止しています。確認が取れると、自動で解除されます。',
        '', '【お振込先】', bank || '（振込先は、お送りした請求書をご覧ください）', `ご依頼人名の前に、請求書番号「${i.number}」を入れてください。`,
        '',
        'すでにお支払い済みの場合は、行き違いですので、ご容赦ください。ご不明な点は、このメールにご返信ください。',
      ] }));
      db.prepare('UPDATE invoices SET overdue_notified = 1 WHERE id = ?').run(i.id);
    }
    // 現地受け取りの期限の前日に、落札者に知らせる
    const soon = db.prepare("SELECT l.* FROM bill_lines l WHERE l.receive = 'pickup' AND l.cleared_at IS NOT NULL AND l.delivered_at IS NULL AND l.cancelled_at IS NULL AND l.kind IN ('lot','promote') AND NOT EXISTS (SELECT 1 FROM pickup_notices n WHERE n.line_id = l.id)").all();
    let pickup = 0;
    for (const l of soon) {
      const by = addDays(jst(l.cleared_at), 7);
      // 前日に動いていなかった日（だれも開かず、サーバーが休んでいた日）があっても、期限までは知らせる
      if (t < addDays(by, -1) || t > by) continue;
      const a = account(l.account_id);
      const ev = l.event_id && db.prepare('SELECT venue_name, venue_address FROM events WHERE id = ?').get(l.event_id);
      notifier.email(a.email, 'pickup', subjectOf(`お受け取りの期限は${jpDay(by)}です`), compose(setting, { name: displayName(a), lines: [
        `${l.label} の、お受け取りの期限が近づいています。`,
        '',
        ...kv([['期限', `${jpDay(by)}まで`], ['場所', ev && `${ev.venue_name}（${ev.venue_address}）`]]),
        '',
        '会場の営業時間内に、お受け取りください。期限に間に合わない場合は、このメールにご返信ください。',
      ] }));
      db.prepare('INSERT INTO pickup_notices (line_id, at) VALUES (?, ?)').run(l.id, nowMs());
      pickup++;
    }
    return { overdue: overdue.length, pickup };
  }

  // 発行者の情報（名称・住所・登録番号・振込先）を変えたとき: まだ送っていない振込の請求書を、新しい内容で作り直す
  // （振込先が未設定のまま発行した請求書に、「（未設定）」が残り続けないように）。送付済みのものは、送ったときのままにする
  function rerenderUnsent() {
    const ids = db.prepare("SELECT id FROM invoices WHERE kind <> 'cash' AND sent_at IS NULL").all().map((r) => r.id);
    for (const id of ids) renderInvoice(id).done.catch((err) => console.error('[invoice] 作り直しに失敗しました', id, err?.message ?? err));
    return ids.length;
  }
  return { syncLines, onEventEnd, suspension, sweep, feeSummary, premiumRate, fixedKeys, sealFixed, rerenderUnsent, filesIdle };
}
