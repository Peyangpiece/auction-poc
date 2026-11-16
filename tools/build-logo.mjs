#!/usr/bin/env node
// 「令和の競り」のロゴを作る。毛筆の楷書の書体（Yuji Syuku。SIL OFL）の文字を図形に変換し、会社のシンボルの色で組む。
//   node tools/build-logo.mjs docs/brand
//   LOGO_FONT=<書体のファイル> LOGO_STYLE=gyosho node tools/build-logo.mjs <出力先>   … 別の書体（行書など）で作る
// 実行には、書体と変換の部品が要る（npm install --no-save opentype.js @fontsource/yuji-syuku）。
// できあがるロゴは図形だけなので、使う側に書体は要らない。
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const opentype = require('opentype.js');
const { chromium } = require('playwright');
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = process.argv[2];
if (!OUT) { console.error('使い方: node tools/build-logo.mjs <出力先のフォルダ>'); process.exit(1); }
// 書体は、既定では Yuji Syuku（楷書。SIL OFL）。LOGO_FONT で、手元にある別の書体のファイルを指定できる
// （利用条件は、書体ごとに確かめること。書体のファイルそのものは、このリポジトリに入れない）
const buf = fs.readFileSync(process.env.LOGO_FONT ?? require.resolve('@fontsource/yuji-syuku/files/yuji-syuku-japanese-400-normal.woff'));
const GYOSHO = process.env.LOGO_STYLE === 'gyosho';
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const NAVY = '#000156', GOLD = '#d4aa00', RED = '#ff0000', WHITE = '#ffffff';

// 文字ごとに、大きさ・上下の位置・詰め具合を決める（「の」を小さく赤に、「競り」を大きく。「令和」は、会社の名前の読みを漢字にしたもの）
// 楷書: 字の大きさと下の線をそろえ、間を均等にとる。行書: 字に大小と流れをつけ、間を詰める。「の」は小さくして赤に
const glyphs = GYOSHO ? [
  { ch: '令', size: 178, dy: 0, gap: -6, role: 'main' },
  { ch: '和', size: 170, dy: 2, gap: -14, role: 'main' },
  { ch: 'の', size: 118, dy: -6, gap: -6, role: 'accent' },
  { ch: '競', size: 190, dy: 6, gap: -24, role: 'main' },
  { ch: 'り', size: 168, dy: 0, gap: 0, role: 'main' },
] : [
  { ch: '令', size: 176, dy: 0, gap: -10, role: 'main' },
  { ch: '和', size: 176, dy: 0, gap: -4, role: 'main' },
  { ch: 'の', size: 118, dy: -8, gap: 0, role: 'accent' },
  { ch: '競', size: 176, dy: 0, gap: -10, role: 'main' },
  { ch: 'り', size: 166, dy: -2, gap: 0, role: 'main' },
];
function wordmark(x0, base) {
  let x = x0; const parts = [];
  for (const g of glyphs) {
    const gl = font.charToGlyph(g.ch);
    parts.push({ role: g.role, d: gl.getPath(x, base + g.dy, g.size).toPathData(2) });
    x += gl.advanceWidth * g.size / font.unitsPerEm + g.gap;
  }
  return { parts, width: x - x0 };
}
/**
 * 下の一本線も、毛筆で書く。同じ書体の横画「一」の形（筆の入りの打ち込み・送り・止め）を、言葉の幅まで引きのばし、
 * 後ろ半分に、墨がかすれた細い筋を入れる。
 */
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function brushLine(x, y, w, id) {
  const src = font.charToGlyph('一').getPath(0, 0, 200);
  const bb = src.getBoundingBox();
  const sx = w / (bb.x2 - bb.x1), sy = 1.12;
  const X = (v) => (x + (v - bb.x1) * sx).toFixed(1), Y = (v) => (y + (v - bb.y1) * sy).toFixed(1);
  const d = src.commands.map((c) => (c.type === 'M' || c.type === 'L' ? `${c.type}${X(c.x)},${Y(c.y)}`
    : c.type === 'C' ? `C${X(c.x1)},${Y(c.y1)} ${X(c.x2)},${Y(c.y2)} ${X(c.x)},${Y(c.y)}`
    : c.type === 'Q' ? `Q${X(c.x1)},${Y(c.y1)} ${X(c.x)},${Y(c.y)}` : 'Z')).join('');
  // かすれ: 筆の運びに沿った、細くて長い筋。後ろへ行くほど増える（毎回同じ形になるよう、乱数の種は固定）
  const r = rng(11), h = (bb.y2 - bb.y1) * sy;
  let gaps = '';
  for (let k = 0; k < 22; k++) {
    const t0 = 0.38 + 0.5 * Math.sqrt(r()), len = 0.06 + r() * 0.2, at = 0.18 + r() * 0.64, thick = 0.5 + r() * 1.5;
    const x0 = x + t0 * w, x1 = Math.min(x + w * 0.985, x0 + len * w), yy = y + h * at - (t0 - 0.5) * 6;
    gaps += `<path d="M${x0.toFixed(1)},${yy.toFixed(1)} Q${((x0 + x1) / 2).toFixed(1)},${(yy - thick).toFixed(1)} ${x1.toFixed(1)},${(yy - 1).toFixed(1)} Q${((x0 + x1) / 2).toFixed(1)},${(yy + thick).toFixed(1)} ${x0.toFixed(1)},${yy.toFixed(1)}Z"/>`;
  }
  return `<mask id="${id}" maskUnits="userSpaceOnUse" x="${x - 20}" y="${y - 20}" width="${w + 40}" height="${h + 40}"><rect x="${x - 20}" y="${y - 20}" width="${w + 40}" height="${h + 40}" fill="#fff"/><g fill="#000">${gaps}</g></mask><path d="${d}" fill="${GOLD}" mask="url(#${id})"/>`;
}
const emblem = 'data:image/png;base64,' + fs.readFileSync(`${ROOT}server/assets/emblem.png`).toString('base64');

function build({ dark = false, withEmblem = false, plain = false }) {
  const pad = 36, base = 200, ex = withEmblem ? 210 : 0;
  const wm = wordmark(pad + ex, base);
  const W = Math.ceil(pad * 2 + ex + wm.width + 58), H = 300;
  const main = dark ? WHITE : NAVY, accent = dark ? GOLD : RED;
  // 文字は、同じ色の細い縁を足して、筆の太さを少し出す
  const letters = wm.parts.map((g) => { const c = g.role === 'accent' ? accent : main; return `<path d="${g.d}" fill="${c}" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/>`; }).join('');
  const line = brushLine(pad + ex + 2, base + 34, wm.width + 14, `kasure${dark ? 'd' : ''}${withEmblem ? 's' : ''}${plain ? 'p' : ''}`);
  // plain: 地の四角を付けない（暗い画面の上に、そのまま置く）
  const bg = dark && !plain ? `<rect width="${W}" height="${H}" rx="14" fill="${NAVY}"/>` : '';
  const mark = withEmblem ? `<image href="${emblem}" x="${pad}" y="${(H - 190) / 2 - 2}" width="190" height="190"/>` : '';
  return { W, H, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="令和の競り"><title>令和の競り</title>${bg}${mark}${line}${letters}</svg>` };
}
const variants = { 'reiwa-no-seri': {}, 'reiwa-no-seri-dark': { dark: true }, 'reiwa-no-seri-symbol': { withEmblem: true }, 'reiwa-no-seri-symbol-dark': { withEmblem: true, dark: true, plain: true } };
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const made = [];
for (const [name, opt] of Object.entries(variants)) {
  const v = build(opt);
  fs.writeFileSync(`${OUT}/${name}.svg`, v.svg);
  const p = await b.newPage({ viewport: { width: v.W, height: v.H }, deviceScaleFactor: 3 });
  await p.setContent(`<body style="margin:0;background:transparent">${v.svg}</body>`);
  await p.screenshot({ path: `${OUT}/${name}.png`, omitBackground: true });
  await p.close();
  made.push({ name, ...v });
}
await b.close();
console.log(made.map((v) => `${v.name} ${v.W}x${v.H}`).join('\n'));
