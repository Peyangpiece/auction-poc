#!/usr/bin/env node
// 画面で使う書体を、News-HP と同じ元ファイル（BIZ UDPゴシック・Inter。どちらも SIL OFL）から切り出す。
//   node tools/build-fonts.mjs <News-HP の fonts-src のパス>
// 日本語は、画面の固定の文言に出てくる文字とかな・記号だけを収める（軽くするため）。
// 商品名やコメントなど、後から入る文字に無い字があれば、端末の書体で表示される。
// 実行には subset-font が要る（npm install --no-save subset-font）。画面の文言を変えたら、もう一度実行する。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import subsetFont from 'subset-font';

const src = process.argv[2];
if (!src) { console.error('使い方: node tools/build-fonts.mjs <fonts-src のパス>'); process.exit(1); }
const web = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i)).join('');
const latin = range(0x20, 0x7e) + '¥…‥–—';
const kana = range(0x3041, 0x3096) + range(0x30a1, 0x30fc) + '、。「」『』（）［］【】・：；！？〜ー￥％＋－／＝　' + range(0xff10, 0xff19);
const used = readdirSync(web).filter((f) => /\.(html|js)$/.test(f)).map((f) => readFileSync(join(web, f), 'utf8')).join('');
// 状態の名前など、サーバーから届く固定の文言に使う字も足す
const extra = '待機配信準備中警告受付断落札流未実施番円件秒人税込最低高入額現在開始価格権利者締再取除外';
const jp = [...new Set([...(latin + kana + used + extra)])].filter((c) => c >= ' ').join('');

for (const w of ['Regular', 'Bold']) {
  const buf = await subsetFont(readFileSync(join(src, `BIZUDPGothic-${w}.ttf`)), jp, { targetFormat: 'woff2' });
  writeFileSync(join(web, `bizudp-${w}.woff2`), buf);
  console.log(`bizudp-${w}.woff2 ${buf.length} bytes`);
}
const inter = await subsetFont(readFileSync(join(src, 'Inter.ttf')), latin, { targetFormat: 'woff2', variationAxes: { wght: { min: 400, max: 700 }, opsz: 14 } });
writeFileSync(join(web, 'inter.woff2'), inter);
console.log(`inter.woff2 ${inter.length} bytes`);
