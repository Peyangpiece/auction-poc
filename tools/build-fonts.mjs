#!/usr/bin/env node
// 画面で使う書体を、元のファイル（Noto Sans JP・Inter。どちらも SIL OFL）から切り出す。
//   node tools/build-fonts.mjs <書体の元ファイルのフォルダ>
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
// サーバーが返す案内の文言（会員登録など）に使う字も収める
const served = ['api.js', 'schema.js'].map((f) => readFileSync(join(web, '..', 'server', 'src', 'mvp', f), 'utf8')).join('');
// 状態の名前など、サーバーから届く固定の文言に使う字も足す
const extra = '待機配信準備中警告受付断落札流未実施番円件秒人税込最低高入額現在開始価格権利者締再取除外';
const jp = [...new Set([...(latin + kana + used + served + extra)])].filter((c) => c >= ' ').join('');

// 日本語は Noto Sans JP（SIL OFL）。太さは 3 つ（400 本文・500 ラベルやボタン・700 見出し）
for (const [w, file] of [[400, 'NotoSansJP_400Regular.ttf'], [500, 'NotoSansJP_500Medium.ttf'], [700, 'NotoSansJP_700Bold.ttf']]) {
  const buf = await subsetFont(readFileSync(join(src, file)), jp, { targetFormat: 'woff2' });
  writeFileSync(join(web, `notosansjp-${w}.woff2`), buf);
  console.log(`notosansjp-${w}.woff2 ${buf.length} bytes`);
}
const inter = await subsetFont(readFileSync(join(src, 'Inter.ttf')), latin, { targetFormat: 'woff2', variationAxes: { wght: { min: 400, max: 700 }, opsz: 14 } });
writeFileSync(join(web, 'inter.woff2'), inter);
console.log(`inter.woff2 ${inter.length} bytes`);
