// 入札と落札の演出、開催のお知らせメールの切り替え、ホーム画面に追加の案内を、実際のブラウザで確かめる（発注者の指示で足した機能）。
import { boot, chromium, devices, check } from './lib.mjs';
import fs from 'node:fs';
const OUT = process.argv[2] ?? null; // 画面の写しを残す場所（省けば残さない）
const snap = (page, name) => (OUT ? page.screenshot({ path: `${OUT}/${name}.png` }) : null);
const sys = await boot({ port: 8196, env: { POC_IVS_MODE: 'always-live' }, members: 3 });
const browser = await chromium.launch();
const errors = [];
const open = async (url, opts) => { const p = await (await browser.newContext(opts)).newPage(); p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => m.type() === 'error' && errors.push(m.text())); await p.goto(url); return p; };
try {
  const con = await open(`${sys.base}/console.html?t=${sys.tokens.auctioneer}`, { viewport: { width: 1200, height: 900 } });
  const b1 = await open(`${sys.base}/bidder.html?t=${sys.tokens.members[0].token}`, { ...devices['iPhone 13'] });
  const b2 = await open(`${sys.base}/bidder.html?t=${sys.tokens.members[1].token}`, { viewport: { width: 1280, height: 860 } });
  for (const b of [b1, b2]) { await b.click('#enter'); await b.waitForFunction(() => document.getElementById('me').textContent.includes('番')); }
  await con.fill('#newTitle', '古い柱時計'); await con.fill('#newPrice', '9500'); await con.click('#create');
  await con.waitForSelector('#b_next:not([hidden])'); await con.click('#b_next');
  await con.waitForFunction(() => document.getElementById('status').textContent.includes('受付中'), null, { timeout: 15000 });
  await b1.waitForFunction(() => document.getElementById('bid').textContent === '入札');
  await b1.click('#bid');
  await b1.waitForFunction(() => document.getElementById('board').classList.contains('bidpop'));
  check(true, '自分の入札が受理されたら、板に演出が出る');
  await b1.waitForTimeout(180); await snap(b1, 'bid-phone');
  await b1.waitForFunction(() => !document.getElementById('board').classList.contains('bidpop'), null, { timeout: 2000 });
  check(true, '入札の演出は 1 秒以内に消える');
  await b2.waitForTimeout(800);
  check((await b2.inputValue('#bidAmount')) === '10,000', '入札の欄には、次の入札額の目安（価格の段）が入っている');
  await b2.fill('#bidAmount', '9501'); await b2.click('#bid');
  await b2.waitForFunction(() => document.getElementById('price').textContent.includes('9,501'));
  check(true, '開始価格以上なら、1円単位の金額（現在価格の1円上）で入札できる');
  await b2.waitForFunction(() => document.getElementById('board').classList.contains('bidpop'));
  await b2.waitForTimeout(200); await snap(b2, 'bid-pc');
  check(!(await b1.evaluate(() => document.getElementById('board').classList.contains('bidpop'))), 'ほかの人の入札では、自分の入札の演出は出ない');
  if (await con.isVisible('#b_urikiri')) { await con.click('#b_urikiri'); await con.click('#dlgOk'); await con.waitForTimeout(300); } // 最低落札額のない品は、うりきりを押してから締める（報告書 89 章）
  await con.click('#b_close'); await con.click('#dlgOk'); // 締めは確かめてから
  await b2.waitForFunction(() => !document.getElementById('winFx').hidden);
  check(true, '落札した本人には、落札の演出が出る');
  await b1.waitForFunction(() => document.getElementById('result').textContent === '2番 落札');
  check(await b1.evaluate(() => document.getElementById('winFx').hidden), '落札していない人には、知らせの札は出ず、板に「2番 落札」と出る');
  await b2.waitForTimeout(700); await snap(b2, 'win-pc');
  await b1.waitForTimeout(250); await snap(b1, 'stamp-phone');
  await b2.waitForFunction(() => document.getElementById('winFx').hidden, null, { timeout: 4000 });
  check(true, '落札の知らせは 2.5 秒ほどで消える');
  // 自分の落札をスマホで
  await con.fill('#newTitle', '漆の盆'); await con.fill('#newPrice', '3000'); await con.click('#create');
  await con.waitForSelector('#b_next:not([hidden])'); await con.click('#b_next');
  await con.waitForFunction(() => document.getElementById('status').textContent.includes('受付中'), null, { timeout: 15000 });
  await b1.waitForFunction(() => document.getElementById('bid').textContent === '入札'); await b1.waitForTimeout(700);
  await b1.click('#bid'); await b1.waitForFunction(() => document.getElementById('right').classList.contains('on'));
  if (await con.isVisible('#b_urikiri')) { await con.click('#b_urikiri'); await con.click('#dlgOk'); await con.waitForTimeout(300); } // 最低落札額のない品は、うりきりを押してから締める（報告書 89 章）
  await con.click('#b_close'); await con.click('#dlgOk'); // 締めは確かめてから
  await b1.waitForFunction(() => !document.getElementById('winFx').hidden);
  await b1.waitForTimeout(650); await snap(b1, 'win-phone');
  // 会員を登録して、そのクッキーで開く
  const register = async (n) => {
    let cookie = '';
    const call = async (u, b) => { const r = await fetch(sys.base + u, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(b) }); const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return r.json(); };
    const phone = `0905555000${n}`;
    await call('/api/register/start', { phone });
    const sms = fs.readFileSync(`${sys.dir}/data/outbox/outbox.ndjson`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((m) => m.to === phone).at(-1).body;
    await call('/api/register/verify', { phone, code: /(\d{6})/.exec(sms)[1] });
    await call('/api/register/complete', { kind: 'b2c', name: `検証 ${n}郎`, email: `fx${n}@example.com`, address: `東京都千代田区${n}`, adult: true, agreed: true, eventMail: true });
    const [name, value] = cookie.split('=');
    return [{ name, value, url: sys.base }];
  };
  const openAs = async (cookies, url, opts) => { const ctx = await browser.newContext(opts); await ctx.addCookies(cookies); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message)); await p.goto(url); return p; };
  const c1 = await register(1);
  const my = await openAs(c1, `${sys.base}/mypage.html#profile`, { ...devices['iPhone 13'] });
  await my.waitForFunction(() => document.getElementById('eventMail').checked);
  check(true, 'マイページに、開催のお知らせメールの切り替えが出る（登録のときに受け取ると選んだ人はオン）');
  await my.click('#eventMail'); await my.waitForFunction(() => document.getElementById('notice').textContent.includes('止めました'));
  await my.reload(); await my.waitForTimeout(500);
  check(!(await my.isChecked('#eventMail')), '切り替えは保存される');
  await my.locator('#eventMail').scrollIntoViewIfNeeded(); await snap(my, 'mypage-switch');
  // 動きを減らす設定
  const calm = await openAs(c1, `${sys.base}/`, { ...devices['iPhone 13'], reducedMotion: 'reduce' });
  await calm.waitForSelector('#installCard'); check(true, 'iPhone のトップページに「ホーム画面に追加」の手順が出る');
  await calm.locator('#installCard').scrollIntoViewIfNeeded(); await snap(calm, 'install-ios');
  await calm.click('#installCard .install__close'); await calm.reload(); await calm.waitForTimeout(300);
  check(!(await calm.$('#installCard')), '「閉じる」を押すと、次からは出ない');
  const android = await openAs(c1, `${sys.base}/`, { ...devices['Pixel 7'] });
  await android.waitForSelector('#installCard'); check((await android.textContent('#installCard')).includes('︙'), 'Android には、メニューからの手順が出る');
  const pc = await openAs(c1, `${sys.base}/`, { viewport: { width: 1280, height: 800 } });
  await pc.waitForTimeout(500); check(!(await pc.$('#installCard')), 'パソコン（インストールの仕組みが来ないとき）には出さない');
  check(errors.length === 0, '画面のエラーがない ' + errors.join(' / '));
  console.log('\nすべて確認しました');
} finally { await browser.close(); sys.stop(); }
