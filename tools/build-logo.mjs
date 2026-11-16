#!/usr/bin/env node
// 「レイワの競り」のロゴを作る。毛筆の書体（Yuji Mai。SIL OFL）の文字を図形に変換し、会社のシンボルの色で組む。
//   node tools/build-logo.mjs docs/brand
// 実行には、書体と変換の部品が要る（npm install --no-save opentype.js @fontsource/yuji-mai）。
// できあがるロゴは図形だけなので、使う側に書体は要らない。
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const opentype = require('opentype.js');
const { chromium } = require('playwright');
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = process.argv[2];
if (!OUT) { console.error('使い方: node tools/build-logo.mjs <出力先のフォルダ>'); process.exit(1); }
const buf = fs.readFileSync(require.resolve('@fontsource/yuji-mai/files/yuji-mai-japanese-400-normal.woff'));
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const NAVY = '#000156', GOLD = '#d4aa00', RED = '#ff0000', WHITE = '#ffffff';

// 文字ごとに、大きさ・上下の位置・詰め具合を決める（「の」を小さく赤に、「競り」を大きく）
const glyphs = [
  { ch: 'レ', size: 150, dy: 0, gap: -22, role: 'main' },
  { ch: 'イ', size: 150, dy: 0, gap: -18, role: 'main' },
  { ch: 'ワ', size: 150, dy: 0, gap: -6, role: 'main' },
  { ch: 'の', size: 96, dy: -6, gap: -2, role: 'accent' },
  { ch: '競', size: 188, dy: 10, gap: -20, role: 'main' },
  { ch: 'り', size: 160, dy: 4, gap: 0, role: 'main' },
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
/** 筆でひいた一本線（左は細く入り、中ほどで太く、右へ払う。払いの先に、かすれを2本） */
function swoosh(x, y, w) {
  // 縦の振れを大きくして、筆の太さと勢いを出す。全体を少し右上がりにする
  const p = (dx, dy) => `${(x + dx * w).toFixed(1)},${(y + dy * 1.75 - dx * 7).toFixed(1)}`;
  const body = `M${p(0, 6)} C${p(0.12, -4)} ${p(0.38, -9)} ${p(0.62, -6)} C${p(0.8, -4)} ${p(0.93, -9)} ${p(1, -15)} C${p(0.95, -3)} ${p(0.82, 6)} ${p(0.62, 8)} C${p(0.36, 11)} ${p(0.14, 12)} ${p(0.02, 13)} C${p(-0.005, 12)} ${p(-0.008, 8)} ${p(0, 6)}Z`;
  const dry1 = `M${p(0.86, 9)} C${p(0.93, 6)} ${p(1.0, 1)} ${p(1.045, -6)} C${p(1.0, 4)} ${p(0.94, 9.5)} ${p(0.88, 11.5)}Z`;
  const dry2 = `M${p(0.8, 12.5)} C${p(0.88, 12)} ${p(0.95, 9.5)} ${p(1.0, 6)} C${p(0.95, 11.5)} ${p(0.88, 14.5)} ${p(0.81, 14.6)}Z`;
  return [body, dry1, dry2];
}
const emblem = 'data:image/png;base64,' + fs.readFileSync(`${ROOT}server/assets/emblem.png`).toString('base64');

function build({ dark = false, withEmblem = false }) {
  const pad = 36, base = 200, ex = withEmblem ? 210 : 0;
  const wm = wordmark(pad + ex, base);
  const W = Math.ceil(pad * 2 + ex + wm.width + 58), H = 300;
  const main = dark ? WHITE : NAVY, accent = dark ? GOLD : RED;
  // 文字は、同じ色の細い縁を足して、筆の太さを少し出す
  const letters = wm.parts.map((g) => { const c = g.role === 'accent' ? accent : main; return `<path d="${g.d}" fill="${c}" stroke="${c}" stroke-width="2.4" stroke-linejoin="round"/>`; }).join('');
  const line = swoosh(pad + ex + 4, base + 52, wm.width + 2).map((d) => `<path d="${d}" fill="${GOLD}"/>`).join('');
  const bg = dark ? `<rect width="${W}" height="${H}" rx="14" fill="${NAVY}"/>` : '';
  const mark = withEmblem ? `<image href="${emblem}" x="${pad}" y="${(H - 190) / 2 - 2}" width="190" height="190"/>` : '';
  return { W, H, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="レイワの競り"><title>レイワの競り</title>${bg}${mark}${line}${letters}</svg>` };
}
const variants = { 'reiwa-no-seri': {}, 'reiwa-no-seri-dark': { dark: true }, 'reiwa-no-seri-symbol': { withEmblem: true } };
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
