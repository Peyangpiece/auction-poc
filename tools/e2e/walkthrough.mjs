#!/usr/bin/env node
// 画面の通し確認（進行コンソール1つ、入札画面3つ）。OBS と IVS は代役を使う。
//   node tools/e2e/walkthrough.mjs            … 確認だけ
//   node tools/e2e/walkthrough.mjs --shots docs/screenshots   … 画面写真も保存する
// 確かめること: 入場、入札、上回りの通知、うりきり、締め、落札の表示、次の品への導線、
//               配信の自動開始と手動停止、止め忘れの注意、切断の検知（生存確認）と再接続、ライブ画面の比率。
import path from 'node:path';
import { boot, chromium, devices, check } from './lib.mjs';

const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : null;
const shot = (page, name, opts = {}) => (shots ? page.screenshot({ path: path.join(shots, name + '.png'), ...opts }) : null);

const sys = await boot({
  port: 8190, withAgent: true,
  env: { POC_IVS_MODE: 'mock', POC_IVS_MOCK_DELAY_MS: '800', POC_LIVE_SETTLE_MS: '1000', POC_STREAM_IDLE_WARN_MS: '1500', POC_VENUE_CONTACT: '（例）テスト会場 000-0000-0000' },
});
const browser = await chromium.launch();
const errors = [];
const open = async (url, opts) => {
  const page = await (await browser.newContext(opts)).newPage();
  page.on('pageerror', (e) => errors.push(`${url.split('?')[0]}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${url.split('?')[0]}: ${m.text()}`));
  await page.goto(url);
  return page;
};
const text = (page, id) => page.textContent('#' + id);
const ratio = (page) => page.evaluate(() => { const r = document.getElementById('videoBox').getBoundingClientRect(); return +(r.width / r.height).toFixed(3); });
const bidderUrl = (i, q = '') => `${sys.base}/bidder.html?t=${sys.tokens.members[i].token}${q}`;

try {
  const con = await open(`${sys.base}/console.html?t=${sys.tokens.auctioneer}`, { viewport: { width: 1200, height: 900 } });
  const b1 = await open(bidderUrl(0, '&net=wifi'), { ...devices['iPhone 13'] });
  const b2 = await open(bidderUrl(1, '&net=4g&mode=venue'), { ...devices['Pixel 7'] });

  console.log('入場');
  await shot(b1, 'gate');
  for (const b of [b1, b2]) await b.click('#enter');
  await b1.waitForFunction(() => document.getElementById('me').textContent.includes('番'));
  const urls = [await b1.evaluate(() => location.href), await con.evaluate(() => location.href)];
  check(urls.every((u) => !/[?&]t=/.test(u)), `参加用の合言葉が、アドレス欄に残らない（${urls.map((u) => u.split('/').pop()).join(' , ')}）`);
  await b1.reload(); await b1.click('#enter');
  await b1.waitForFunction(() => document.getElementById('me').textContent.includes('番'));
  check(true, '再読み込みしても、同じタブなら入り直せる');
  check((await ratio(b1)) === 1.333, 'ライブ画面は、停止中も 4:3');
  check(await b1.isHidden('#bid') && (await text(b1, 'status')) === '待機中', '品がない間は、入札ボタンを出さず、「待機中」だけを出す');
  await shot(b1, 'bidder-watch');

  console.log('品の追加と開始（配信の自動開始）');
  await con.fill('#newTitle', 'テスト品'); await con.fill('#newPrice', '9500');
  await con.fill('#newReserve', '11000');
  await con.click('#create');
  await con.waitForSelector('#b_next:not([hidden])');
  check((await text(con, 'b_next')).includes('No.1'), '板の下に「No.1 を開始」が出る');
  await shot(con, 'console-waiting');
  await con.click('#b_next');
  await con.waitForFunction(() => document.getElementById('status').textContent.includes('配信準備中'));
  await con.waitForFunction(() => document.getElementById('status').textContent.includes('受付中'), null, { timeout: 15000 });
  check((await text(con, 's_obs')) === '配信中', '競りを始めると、配信が自動で始まる');
  check((await con.isHidden('#b_next')) && (await con.isVisible('#b_close')) && (await con.isVisible('#b_urikiri')), '受付中は「締め」「うりきり」「中断」が出る（うりきりは、ランプが消えている品だけ）');

  console.log('カメラの切り替え');
  await con.waitForFunction(() => document.querySelectorAll('#cameras .camopt').length === 3);
  check((await con.$$eval('#cameras .camopt', (bs) => bs.map((b) => b.textContent).join(','))) === 'スマホ,無線,USB', '進行コンソールに、OBS のカメラ（スマホ・無線・USB）が並ぶ。カメラでないシーンは出ない');
  check((await con.getAttribute('#cameras [data-camera="カメラ: スマホ"]', 'aria-pressed')) === 'true', 'いま映しているカメラが分かる');
  await con.click('#cameras [data-camera="カメラ: USB"]');
  await con.waitForFunction(() => document.querySelector('#cameras [data-camera="カメラ: USB"]')?.getAttribute('aria-pressed') === 'true');
  check((await text(con, 's_obs')) === '配信中' && (await text(con, 'status')).includes('受付中'), 'カメラを切り替えても、配信と競りは止まらない');
  await con.waitForFunction(() => document.getElementById('s_video').textContent === '960×720');
  check(true, 'OBS の出力解像度は、配信が止まっていたときに 960×720 にそろえてあり、進行コンソールに出る');
  await shot(con, 'console-camera');

  console.log('入札');
  await b1.waitForFunction(() => document.getElementById('bid').textContent === '入札');
  check(true, '入ってすぐ、入札できる（切り替えは要らない）');
  await b1.click('#bid');
  await b1.waitForFunction(() => document.getElementById('right').classList.contains('on'));
  check(!(await b1.evaluate(() => document.getElementById('urikiri').classList.contains('on'))), '最低落札額に届く前は、「うりきり」は消えている');
  check(!(await b1.content()).includes('11,000'), '最低落札額の金額は、参加者の画面のどこにも出ない');
  await shot(b1, 'bidder-urikiri-before');
  await b2.waitForFunction(() => document.getElementById('bid').textContent === '入札');
  await shot(b2, 'bidder-joined');
  await b2.waitForTimeout(700); // 金額が変わった直後は押せない時間がある
  await b2.click('#bid');
  await b1.waitForFunction(() => document.body.classList.contains('outbid'));
  check((await text(b1, 'msg')).includes('上回られました'), '上回られたら、画面の色と文言で知らせる');
  await b1.waitForTimeout(350);
  await shot(b1, 'bidder-outbid');
  await b1.waitForFunction(() => !document.body.classList.contains('outbid'));
  await b1.waitForTimeout(700);
  await b1.click('#bid');
  await b1.waitForFunction(() => document.getElementById('urikiri').classList.contains('on'));
  check(true, '最低落札額に届くと、「うりきり」が点く');

  console.log('コメント');
  await b2.fill('#cmtText', '状態はどうですか？');
  await b2.click('#cmtSend');
  await b1.waitForFunction(() => document.getElementById('comments').textContent.includes('状態は'));
  await con.waitForFunction(() => document.getElementById('comments').textContent.includes('状態は'));
  check(true, 'コメントが、ほかの参加者と進行役に届く');
  await shot(con, 'console', { fullPage: true });
  await shot(b1, 'bidder-comment', { fullPage: true });
  const pc = await open(bidderUrl(2, '&net=pc'), { viewport: { width: 1280, height: 800 } });
  await pc.click('#enter');
  await pc.waitForFunction(() => document.getElementById('price').textContent.includes('11,000'));
  check((await ratio(pc)) === 1.333, 'PC でも、ライブ画面は 4:3');
  check((await text(con, 'result')).includes('1番が落札'), '進行役の板に、締めたときの結果が先に出る');
  await shot(pc, 'bidder-pc');

  console.log('締め');
  if (await con.isVisible('#b_urikiri')) { await con.click('#b_urikiri'); await con.click('#dlgOk'); await con.waitForTimeout(300); } // 最低落札額のない品は、うりきりを押してから締める（報告書 89 章）
  await con.click('#b_close');
  await con.waitForSelector('#dlg[open]');
  check((await con.textContent('#dlgBody')).includes('1番') && (await con.textContent('#dlgBody')).includes('落札'), '締めは、結果（だれが・いくらで落札か）を書いて確かめる');
  check(await con.evaluate(() => document.activeElement?.id === 'dlgCancel'), '締めの確かめは、最初のフォーカスが「やめる」');
  await con.click('#dlgOk');
  await b1.waitForFunction(() => document.getElementById('result').textContent.includes('あなたが落札'));
  await b2.waitForFunction(() => document.getElementById('result').textContent.includes('1番 落札'));
  check(true, '落札した本人には「あなたが落札しました」、ほかの人には番号が出る');
  await b1.waitForTimeout(400);
  await shot(b1, 'bidder-won');

  console.log('配信（自動では止まらない。止め忘れの注意。手動で停止）');
  await con.waitForFunction(() => document.getElementById('idleWarn').textContent.includes('配信が続いています'), null, { timeout: 10000 });
  check((await text(con, 's_obs')) === '配信中', '競りが終わっても、配信は続く');
  check(true, '競りがないまま配信が続くと、進行コンソールに注意が出る');
  await shot(con, 'console-after-close');
  await con.click('[data-cmd="stream_stop"]');
  await con.waitForSelector('#dlg[open]');
  check((await con.textContent('#dlgBody')).includes('全員の映像'), '「配信を停止」は、全員の映像が止まることを書いて確かめる');
  await con.click('#dlgOk');
  await con.waitForFunction(() => document.getElementById('s_obs').textContent === '停止', null, { timeout: 10000 });
  await con.waitForFunction(() => document.getElementById('idleWarn').textContent === '', null, { timeout: 5000 });
  check(true, '「配信を停止」で止まり、注意も消える');

  console.log('切断の検知（生存確認）と再接続');
  // サーバーを一時停止する。接続は切れないが、応答が来なくなる（回線が黙って切れたのと同じ）
  sys.server.kill('SIGSTOP');
  const t0 = Date.now();
  await b1.waitForFunction(() => document.getElementById('overlay').style.display === 'flex', null, { timeout: 15000 });
  const detected = Date.now() - t0;
  check(detected < 12000, `応答が止まってから ${(detected / 1000).toFixed(1)} 秒で「再接続中」が出る`);
  await shot(b1, 'bidder-reconnecting');
  sys.server.kill('SIGCONT');
  const t1 = Date.now();
  await b1.waitForFunction(() => document.getElementById('overlay').style.display === 'none', null, { timeout: 15000 });
  check(Date.now() - t1 < 10000, `サーバーが戻ってから ${((Date.now() - t1) / 1000).toFixed(1)} 秒でつながり直す`);
  check((await text(b1, 'result')).includes('あなたが落札'), 'つながり直した後、状態が正しく戻る');

  console.log('強制終了からの復帰');
  await con.click('#devBox summary');
  await con.click('[data-crash="now"]');
  await shot(con, 'console-dialog');
  await con.click('#dlgOk');
  await b1.waitForFunction(() => document.getElementById('overlay').style.display === 'flex', null, { timeout: 15000 });
  sys.restartServer();
  await b1.waitForFunction(() => document.getElementById('overlay').style.display === 'none', null, { timeout: 15000 });
  check((await text(b1, 'result')).includes('あなたが落札'), 'サーバーを起動し直した後も、落札の結果が残っている');

  console.log('暗い画面');
  const dark = await open(bidderUrl(2), { ...devices['iPhone 13'], colorScheme: 'dark' });
  await shot(dark, 'gate-dark');
  const cdark = await open(`${sys.base}/console.html?t=${sys.tokens.auctioneer}`, { viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  await cdark.waitForTimeout(500);
  await shot(cdark, 'console-dark');

  check(errors.length === 0, `画面のスクリプトのエラーが 0 件（${JSON.stringify(errors)}）`);
  console.log('\n通し確認: すべて成功');
} catch (err) {
  console.error('\n' + err.message);
  if (errors.length) console.error('画面のエラー:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  sys.stop();
}
