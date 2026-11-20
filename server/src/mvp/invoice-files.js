// 請求書のファイルを作る: PDF（正本）と Excel（.xlsx）。2つの記載内容は同じにする（FR-INV-007）。
//
// PDF の書体・文字の大きさ・配置は、発注者から示された原本の請求書に合わせてある（発注者の指示）:
//   書体 … 源真ゴシック（Gen Shin Gothic）の Medium と Bold。SIL Open Font License 1.1。PDF に埋め込む
//   大きさ … 題 24、宛名 14、ご請求金額 12、社名 10.5、日付・請求番号・振込先 10、本文と表 9.5、住所など 9（ポイント）
//   配置 … 原本の PDF から読み取った位置（左 35・右 560、表の縦線 350・417・482、行の高さ 25、線の太さ 0.9）
//
// 【未検証】適格請求書（インボイス）の記載事項と端数処理は、税理士の確認を受けていない（FR-INV-002）。
// いまは、税率10%だけ・1通につき1回の端数処理（切り捨て）で、税込の合計から消費税額を割り戻している。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');
const FONT = path.join(ASSETS, 'GenShinGothic-Medium.ttf');
const FONT_BOLD = path.join(ASSETS, 'GenShinGothic-Bold.ttf');
const LOGO = path.join(ASSETS, 'emblem.png');
const num = (n) => Number(n).toLocaleString('ja-JP');
const jpDate = (d) => { const [y, m, day] = d.split('-').map(Number); return `${y}年${m}月${day}日`; };
// 貼り付けた文字に、書体にない記号（改行しないハイフンなど）が混ざっていても、文字化けさせない
const clean = (v) => String(v ?? '').replace(/[\u2010-\u2015\u2212\uFE63\uFF0D]/g, '-').replace(/[\u00A0\u2000-\u200B]/g, ' '); // 全角の空白は、入れたとおりに残す
const TITLE = { cash: '請求書 兼 領収書', transfer: '請求書', promote: '請求書', penalty: '請求書' };

/** 請求書に書く内容を、PDF と Excel で共通の形にまとめる */
function content({ invoice, lines, shipping = [], org: rawOrg, to: rawTo, issuedOn, paidOn, subject: rawSubject, premium, seal }) {
  const org = Object.fromEntries(Object.entries(rawOrg).map(([k, v]) => [k, clean(v)]));
  const to = { ...rawTo, name: clean(rawTo.name), address: clean(rawTo.address) };
  const subject = clean(rawSubject);
  const total = invoice.total;
  // 違約金・遅延損害金は、損害の賠償にあたり、消費税の対象外とした【未検証】。落札代金は税率10%（内税）
  const taxable = invoice.kind === 'penalty' ? 0 : total;
  const tax = Math.floor(taxable * 10 / 110);
  // 原本にない注記（依頼人名に請求番号を入れること・振込手数料・受け取り方法・送料の説明）は、載せない（発注者の指示）
  const notes = [];
  return {
    title: TITLE[invoice.kind], number: invoice.number, date: jpDate(issuedOn), to, subject, total,
    // 支払期限は、発行日の5日後（違約金などは7日後）の日付だけを書く（発注者の指示）
    due: invoice.kind === 'cash' ? `領収日 : ${jpDate(paidOn)}（現金にて領収しました）` : `お支払い期限 : ${jpDate(invoice.due_date)}`,
    // 発行者: 住所（郵便番号から。改行できる）のあと、1行あけて、電話・メール・登録番号（原本と同じ並び）
    issuer: { name: org.org_name, address: String(org.org_address ?? '').split('\n').filter(Boolean), contact: [org.org_tel && `TEL: ${org.org_tel}`, org.org_email, `登録番号: ${org.invoice_reg_no || '（未設定）'}`].filter(Boolean) },
    // 落札した品を1行ずつ。そのあとに、買歩銭を1行（発注者から示された見本と同じ並び）
    rows: [...lines.map((l) => [clean(l.label), 1, l.amount, l.amount]), ...(premium?.total ? [['買歩銭', 1, premium.total, premium.total]] : []),
      // 最後に、送料（主催者管理者が手で入れた金額と内容）
      ...shipping.map((l) => [clean(l.label), 1, l.amount, l.amount])],
    taxLabel: taxable ? '消費税 (10% 内税)' : '消費税', taxValue: taxable ? `(${num(tax)})` : '対象外',
    bank: invoice.kind === 'cash' ? null : (org.bank_account || '（未設定）'),
    seal, // 印鑑の画像（主催者設定で登録したもの。なければ押さない）
    notes,
  };
}

// 文字の縦の位置: 原本と画像で比べて、文字そのものの位置がそろうように、書体の上の余白の分（大きさの2割）を引く
const TOP_ADJUST = 0.2;
function writePdf(file, c) {
  return new Promise((resolve, reject) => {
    // 2ページ以上になったら、あとから各ページに請求番号とページ数を書き足すので、ページを貯めておく
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `${c.title} ${c.number}` } });
    const out = fs.createWriteStream(file);
    out.on('finish', () => resolve());
    out.on('error', reject);
    doc.pipe(out);
    doc.registerFont('M', FONT).registerFont('B', FONT_BOLD);
    doc.lineWidth(0.9).strokeColor('#000').fillColor('#000');
    const L = 35, R = 560, PAD = 7, NUM_R = 6.7;
    const LT = L + 0.2; // 左の文字の始まり（線は 35 ちょうど。文字は、原本と画像で比べて 0.2 だけ右）
    /** 文字を置く。top は、文字の上端の位置（原本から読み取った値） */
    const T = (str, x, top, size, { font = 'M', align = 'left', width = null, underline = false } = {}) => {
      doc.font(font).fontSize(size);
      const w = width ?? doc.widthOfString(str);
      // 太字は、書体の上の余白が少し大きいので、その分も引く
      doc.text(str, x, top - size * (font === 'B' ? TOP_ADJUST + 0.045 : TOP_ADJUST), { width: width ?? w + 2, align, lineBreak: width !== null, underline });
      return w;
    };
    const right = (str, edge, top, size, opt = {}) => { doc.font(opt.font ?? 'M').fontSize(size); return T(str, edge - doc.widthOfString(str), top, size, opt); };

    right(c.date, R + 0.2, 28.7, 10);
    right(`請求番号: ${c.number}`, R + 0.2, 50.9, 10);
    doc.font('M').fontSize(24);
    T(c.title, (595.28 - doc.widthOfString(c.title)) / 2, 81.4, 24);

    // 左: 宛先（下線つき）・件名・ご請求金額（下線つき）・期限
    // 宛名は、右の発行者（エンブレム）に重ならない幅（275）に収める。長い名前は、文字を小さくして1行に収める（原本の 14 から、10 まで）
    const NAME_MAX = 275;
    const nameText = `${c.to.name} 様`;
    let nameSize = 14;
    doc.font('M');
    while (nameSize > 10 && doc.fontSize(nameSize).widthOfString(nameText) > NAME_MAX) nameSize -= 0.5;
    let nameW;
    if (doc.fontSize(nameSize).widthOfString(nameText) <= NAME_MAX) {
      nameW = T(nameText, L, 125.7 + (14 - nameSize) * 0.8, nameSize);
    } else {
      // それでも収まらない名前は、10 の大きさで、2行に折り返す（下線は、2行目の下）
      doc.font('M').fontSize(10).text(nameText, L, 113 - 10 * TOP_ADJUST, { width: NAME_MAX, lineGap: 1 });
      nameW = NAME_MAX;
    }
    // 宛名の下線: 原本と同じ高さ（139.29）で、宛名の文字の幅ちょうど
    doc.moveTo(L, 139.29).lineTo(L + nameW, 139.29).stroke();
    T(`件名 : ${c.subject}`, LT, 158, 9.5, { width: 270 });
    T('下記のとおりご請求申し上げます。', LT, 180, 9.5);
    T('ご請求金額', LT, 205.1, 12);
    right(`¥ ${num(c.total)} -`, 264, 205.1, 12);
    doc.moveTo(L, 220.31).lineTo(265.1, 220.31).stroke();
    T(c.due, LT, 233.3, 9.5, { width: 270 });

    // 右: 発行者（会社のシンボル、名称、住所、電話・メール・登録番号、印鑑）
    const rx = 320;
    doc.image(LOGO, 320.5, 125.8, { width: 60 });
    T(c.issuer.name, rx, 192.9, 10.5);
    let ry = 218.4;
    for (const line of c.issuer.address) { T(line, rx, ry, 9); ry += 11.5; }
    ry += 10.8; // 住所と連絡先のあいだを、1行あける
    for (const line of c.issuer.contact) { T(line, rx, ry, 9); ry += 11.4; }
    // 印鑑: 原本と同じ枠（左上 500.2・193.0、幅 58.25・高さ 60pt）に、縦横の比を保って収める（原本の PDF を 600dpi で測った値）
    if (c.seal) doc.image(c.seal, 500.2, 193.0, { fit: [58.25, 60] });

    // 表: 品番・品名｜数量｜単価｜金額
    const col = [L, 350, 417, 482, R], H = 25;
    // 2ページ目からは、上に請求番号を書いて、どの請求書の続きか分かるようにする
    const nextPage = () => { doc.addPage(); right(`${c.title}　請求番号: ${c.number}（続き）`, R + 0.2, 24, 9); return 46; };
    const head = (top) => {
      doc.rect(L, top, R - L, H).fillAndStroke('#d9d8d8', '#000').fillColor('#000');
      for (const x of col.slice(1, 4)) doc.moveTo(x, top).lineTo(x, top + H).stroke();
      ['品番・品名', '数量', '単価', '金額'].forEach((t, i) => { doc.font('B').fontSize(9.5); T(t, (col[i] + col[i + 1]) / 2 - doc.widthOfString(t) / 2, top + 7.6, 9.5, { font: 'B' }); });
    };
    let y = Math.max(318.44, ry + 20);
    head(y); y += H;
    const NAME_W = col[1] - L - PAD * 2;
    for (const [label, qty, unit, amount] of c.rows) {
      // 長い品名は、切らずに枠の中で折り返し、行を高くする（品目は、請求書に最後まで載せる。1行に収まる品は、原本と同じ高さ 25）
      doc.font('M').fontSize(9.5);
      const lines = Math.max(1, Math.round(doc.heightOfString(label, { width: NAME_W, lineGap: 2.5 }) / (doc.currentLineHeight() + 2.5)));
      const rh = H + (lines - 1) * 12.5;
      if (y + rh > 800) { y = nextPage(); head(y); y += H; }
      doc.rect(L, y, R - L, rh).stroke();
      for (const x of col.slice(1, 4)) doc.moveTo(x, y).lineTo(x, y + rh).stroke();
      if (lines === 1) T(label, L + PAD, y + 7.9, 9.5);
      else doc.font('M').fontSize(9.5).text(label, L + PAD, y + 7.9 - 9.5 * TOP_ADJUST, { width: NAME_W, lineGap: 2.5 });
      right(String(qty), col[2] - PAD, y + 7.9, 9.5);
      right(num(unit), col[3] - NUM_R, y + 7.9, 9.5);
      right(num(amount), col[4] - NUM_R, y + 7.9, 9.5);
      y += rh;
    }
    // 小計・消費税・合計（表の右下）
    if (y + H * 3 > 800) y = nextPage();
    for (const [label, value] of [['小計', num(c.total)], [c.taxLabel, c.taxValue], ['合計', num(c.total)]]) {
      doc.rect(col[1], y, R - col[1], H).stroke();
      doc.moveTo(col[3], y).lineTo(col[3], y + H).stroke();
      T(label, col[1] + 7.1, y + 7.75, 9.5);
      right(value, col[4] - NUM_R, y + 7.9, 9.5);
      y += H;
    }
    y += 14.3;
    if (y > 770) y = nextPage();
    if (c.bank) {
      T('お振込先：', L, y, 10, { font: 'B' });
      T(c.bank, LT, y + 12.6, 10, { width: R - L });
      y += 34;
    }
    for (const note of c.notes) { T(note, L, y, 9, { width: R - L }); y = doc.y + 3; }
    // 2ページ以上のときだけ、各ページの下に「1 / 2」と書く（1ページの請求書は、原本と同じく何も書かない）
    const { count } = doc.bufferedPageRange();
    if (count > 1) {
      for (let i = 0; i < count; i++) {
        doc.switchToPage(i);
        const label = `${i + 1} / ${count}`;
        doc.font('M').fontSize(9);
        T(label, (595.28 - doc.widthOfString(label)) / 2, 815, 9);
      }
    }
    doc.end();
  });
}

async function writeXlsx(file, c) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('請求書');
  sheet.columns = [{ width: 48 }, { width: 10 }, { width: 14 }, { width: 14 }];
  sheet.addRow([c.title]).font = { size: 16, bold: true };
  sheet.addRow(['正本は PDF の請求書です。この Excel は、内容の確認と集計のためのものです。']);
  sheet.addRow([]);
  sheet.addRow([c.date]);
  sheet.addRow([`請求番号: ${c.number}`]);
  sheet.addRow([`${c.to.name} 様`]);
  sheet.addRow([`件名 : ${c.subject}`]);
  sheet.addRow(['ご請求金額', '', '', c.total]).getCell(4).numFmt = '"¥"#,##0';
  sheet.addRow([c.due]);
  sheet.addRow([]);
  sheet.addRow([c.issuer.name]);
  for (const line of [...c.issuer.address, ...c.issuer.contact]) sheet.addRow([line]);
  sheet.addRow([]);
  sheet.addRow(['品番・品名', '数量', '単価', '金額']).font = { bold: true };
  for (const row of c.rows) { const r = sheet.addRow(row); r.getCell(3).numFmt = '#,##0'; r.getCell(4).numFmt = '#,##0'; }
  sheet.addRow(['', '小計', '', c.total]).getCell(4).numFmt = '#,##0';
  sheet.addRow(['', c.taxLabel, '', c.taxValue]);
  const total = sheet.addRow(['', '合計', '', c.total]);
  total.font = { bold: true };
  total.getCell(4).numFmt = '#,##0';
  sheet.addRow([]);
  if (c.bank) { sheet.addRow(['お振込先：']); sheet.addRow([c.bank]); }
  for (const note of c.notes) sheet.addRow([note]);
  await book.xlsx.writeFile(file);
}

/** PDF と Excel を作る。ファイルの場所はすぐに返し、書き終わりは done で待てる */
export function makeInvoiceFiles({ dir, invoice, lines, shipping = [], org, to, issuedOn, paidOn, subject, premium, seal = null }) {
  const c = content({ invoice, lines, shipping, org, to, issuedOn, paidOn, subject, premium, seal });
  const pdf = path.join(dir, `${invoice.number}.pdf`);
  const xlsx = path.join(dir, `${invoice.number}.xlsx`);
  return { pdf, xlsx, done: Promise.all([writePdf(pdf, c), writeXlsx(xlsx, c)]) };
}

/** 月ごとの請求書の一覧（Excel）。請求書の状態は、明細の消し込みから導く（FR-INV-003） */
export async function makeInvoiceList(month, rows) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(`請求書 ${month}`);
  sheet.columns = [{ width: 16 }, { width: 12 }, { width: 28 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 }];
  sheet.addRow(['請求番号', '種類', '宛先', '発行日', '送付日', '支払期限', '合計', '消し込み済み', '状態']).font = { bold: true };
  for (const r of rows) { const row = sheet.addRow(r.map((v) => (typeof v === 'string' ? clean(v) : v))); row.getCell(7).numFmt = '#,##0'; row.getCell(8).numFmt = '#,##0'; }
  return Buffer.from(await book.xlsx.writeBuffer());
}
