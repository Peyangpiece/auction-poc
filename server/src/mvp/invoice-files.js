// 請求書のファイルを作る: PDF（正本）と Excel（.xlsx）。2つの記載内容は同じにする（FR-INV-007）。
// PDF には日本語の書体（BIZ UDPゴシック。SIL OFL）を埋め込む。どの端末で開いても文字化けしないようにするため。
//
// 【未検証】適格請求書（インボイス）の記載事項と端数処理は、税理士の確認を受けていない（FR-INV-002）。
// いまは、税率10%だけ・1通につき1回の端数処理（切り捨て）で、税込の合計から消費税額を割り戻している。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');
const FONT = path.join(ASSETS, 'BIZUDPGothic-Regular.ttf');
const LOGO = path.join(ASSETS, 'emblem.png');
const num = (n) => Number(n).toLocaleString('ja-JP');
const jpDate = (d) => { const [y, m, day] = d.split('-').map(Number); return `${y}年${m}月${day}日`; };
const TITLE = { cash: '請求書 兼 領収書', transfer: '請求書', promote: '請求書', penalty: '請求書' };

/** 請求書に書く内容を、PDF と Excel で共通の形にまとめる */
function content({ invoice, lines, org, to, issuedOn, paidOn, subject, premium }) {
  const total = invoice.total;
  // 違約金・遅延損害金は、損害の賠償にあたり、消費税の対象外とした【未検証】。落札代金は税率10%（内税）
  const taxable = invoice.kind === 'penalty' ? 0 : total;
  const tax = Math.floor(taxable * 10 / 110);
  const notes = [];
  if (invoice.kind !== 'cash') {
    notes.push(`お振込の際は、依頼人名に請求番号（${invoice.number}）を入れてください。振込手数料は、お客様のご負担となります。`);
  }
  if (invoice.receive_note) notes.push(`受け取り方法: ${invoice.receive_note}`);
  if (invoice.kind !== 'penalty') notes.push('落札価格に送料は含まれません。配送の場合、送料は後日、別にご請求します。');
  return {
    title: TITLE[invoice.kind], number: invoice.number, date: jpDate(issuedOn), to, subject, total,
    // 支払期限は、送付日から数える（FR-INV-005）。請求書を作る時点では送付日が決まっていないので、数え方を書く
    due: invoice.kind === 'cash' ? `領収日 : ${jpDate(paidOn)}（現金にて領収しました）`
      : `お支払い期限 : 送付日の翌日から${invoice.due_days}日目${invoice.shift_holiday ? '（金融機関の休業日は前営業日）' : ''}`,
    issuer: { name: org.org_name, lines: [...String(org.org_address ?? '').split('\n').filter(Boolean), org.org_tel && `TEL: ${org.org_tel}`, org.org_email, `登録番号: ${org.invoice_reg_no || '（未設定）'}`].filter(Boolean) },
    // 落札した品を1行ずつ。そのあとに、買歩銭を1行（発注者から示された見本と同じ並び）
    rows: [...lines.map((l) => [l.label, 1, l.amount, l.amount]), ...(premium?.total ? [['買歩銭', 1, premium.total, premium.total]] : [])],
    taxLabel: taxable ? '消費税 (10% 内税)' : '消費税', taxValue: taxable ? `(${num(tax)})` : '対象外',
    bank: invoice.kind === 'cash' ? null : (org.bank_account || '（未設定）'),
    notes,
  };
}

// レイアウトは、発注者から示された見本に合わせた: 右上に日付と請求番号、中央に題、左に宛先・件名・ご請求金額・期限、
// 右に発行者、罫線つきの表（品番・品名／数量／単価／金額）、右下に小計・消費税・合計、最後に振込先。
function writePdf(file, c) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36, info: { Title: `${c.title} ${c.number}` } });
    const out = fs.createWriteStream(file);
    out.on('finish', resolve);
    out.on('error', reject);
    doc.pipe(out);
    doc.font(FONT).lineWidth(0.8).lineGap(2);
    const L = 36, R = 559;
    doc.fontSize(10).text(c.date, L, 30, { width: R - L, align: 'right' });
    doc.text(`請求番号: ${c.number}`, L, 52, { width: R - L, align: 'right' });
    doc.fontSize(24).text(c.title, L, 82, { width: R - L, align: 'center' });

    // 左: 宛先・件名・ご請求金額・期限
    const leftW = 240;
    doc.fontSize(14).text(`${c.to.name} 様`, L, 128, { width: leftW, underline: true });
    let y = Math.max(doc.y + 10, 160);
    doc.fontSize(9.5).text(`件名 : ${c.subject}`, L, y, { width: leftW });
    y = doc.y + 12;
    doc.text('下記のとおりご請求申し上げます。', L, y, { width: leftW });
    y = doc.y + 14;
    doc.fontSize(12).text('ご請求金額', L, y).text(`¥ ${num(c.total)} -`, L, y, { width: leftW, align: 'right' });
    doc.moveTo(L, y + 18).lineTo(L + leftW, y + 18).stroke();
    doc.fontSize(9.5).text(c.due, L, y + 28, { width: leftW });
    const leftEnd = doc.y;

    // 右: 発行者（エンブレム、名称、住所、電話、登録番号）
    const rx = 325;
    doc.image(LOGO, rx, 122, { width: 60 });
    doc.fontSize(11).text(c.issuer.name, rx, 192, { width: R - rx });
    doc.fontSize(9.5);
    let ry = 214;
    for (const line of c.issuer.lines) { doc.text(line, rx, ry, { width: R - rx }); ry = doc.y + 1; }

    // 表
    const col = [L, 350, 418, 487, R]; // 品番・品名 | 数量 | 単価 | 金額
    const rowH = 25;
    const cell = (x1, x2, top, text, { align = 'left', fill = null, h = rowH } = {}) => {
      if (fill) doc.rect(x1, top, x2 - x1, h).fillAndStroke(fill, '#000'); else doc.rect(x1, top, x2 - x1, h).stroke();
      doc.fillColor('#000').text(text, x1 + 7, top + (h - 10) / 2 - 1, { width: x2 - x1 - 14, align, lineBreak: false, ellipsis: true });
    };
    const head = (top) => ['品番・品名', '数量', '単価', '金額'].forEach((t, i) => cell(col[i], col[i + 1], top, t, { align: 'center', fill: '#d9d9d9' }));
    y = Math.max(leftEnd, ry) + 28;
    head(y); y += rowH;
    for (const [label, qty, unit, amount] of c.rows) {
      if (y + rowH > 790) { doc.addPage(); y = 40; head(y); y += rowH; }
      cell(col[0], col[1], y, label);
      cell(col[1], col[2], y, String(qty), { align: 'right' });
      cell(col[2], col[3], y, num(unit), { align: 'right' });
      cell(col[3], col[4], y, num(amount), { align: 'right' });
      y += rowH;
    }
    // 小計・消費税・合計（表の右下）
    if (y + rowH * 3 > 790) { doc.addPage(); y = 40; }
    for (const [label, value] of [['小計', num(c.total)], [c.taxLabel, c.taxValue], ['合計', num(c.total)]]) {
      cell(col[1], col[3], y, label);
      cell(col[3], col[4], y, value, { align: 'right' });
      y += rowH;
    }
    y += 18;
    if (y > 760) { doc.addPage(); y = 40; }
    if (c.bank) {
      doc.fontSize(10).text('お振込先：', L, y);
      doc.text(c.bank, L, doc.y + 1, { width: R - L });
      y = doc.y + 10;
    }
    doc.fontSize(8.5);
    for (const note of c.notes) { doc.text(note, L, y, { width: R - L }); y = doc.y + 2; }
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
  for (const line of c.issuer.lines) sheet.addRow([line]);
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
export function makeInvoiceFiles({ dir, invoice, lines, org, to, issuedOn, paidOn, subject, premium }) {
  const c = content({ invoice, lines, org, to, issuedOn, paidOn, subject, premium });
  const pdf = path.join(dir, `${invoice.number}.pdf`);
  const xlsx = path.join(dir, `${invoice.number}.xlsx`);
  return { pdf, xlsx, done: Promise.all([writePdf(pdf, c), writeXlsx(xlsx, c)]) };
}
