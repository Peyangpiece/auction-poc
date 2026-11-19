#!/usr/bin/env node
// 画面の通し確認（MVP の 1）: スタッフのログイン → 設定・開催 → 進行コンソールでのその場の商品登録 → 会員登録 → ログイン。
//   node tools/e2e/members.mjs [--shots docs/screenshots]
// データはすべて架空のもの。SMS とメールは、開発用の書き出し（data/outbox）から読む。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { boot, chromium, devices, check, ROOT } from './lib.mjs';
import { totp } from '../../server/src/mvp/security.js';

const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : null;
const shot = (page, name, opts = {}) => (shots ? page.screenshot({ path: path.join(shots, name + '.png'), ...opts }) : null);

const sys = await boot({ port: 8194, env: { POC_IVS_MODE: 'always-live' } });
const dataDir = path.join(sys.dir, 'data');
const env = { ...process.env, POC_DATA_DIR: dataDir };
const makeStaff = (id, name, role) => {
  execFileSync('node', ['tools/create-admin.js', '--id', id, '--name', name, '--role', role], { cwd: ROOT, env, stdio: 'ignore' });
  const text = fs.readFileSync(path.join(dataDir, `staff-initial-${id}.txt`), 'utf8');
  return { id, password: /仮のパスワード: (\S+)/.exec(text)[1], secret: /認証アプリの鍵: (\S+)/.exec(text)[1] };
};
const outbox = () => fs.readFileSync(path.join(dataDir, 'outbox', 'outbox.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
// 一覧の行の操作を押す。見えていなければ、その行の「⋯」を開いてから押す
const rowAction = async (page, rowText, label) => {
  const row = page.locator(`#panel tr:has-text("${rowText}")`);
  await row.first().locator('td.act').waitFor();
  const direct = row.locator(`td.act > button:has-text("${label}")`);
  if (await direct.count()) return direct.first().click();
  await row.locator('td.act .more__btn').click();
  await page.locator(`.more:popover-open >> text=${label}`).click();
};
const lastCode = () => /認証番号は (\d{6})/.exec(outbox().filter((m) => m.channel === 'sms').at(-1).body)[1];

// 参加できるのは開催の当日だけなので、開催日は今日（日本時間）にする
const jstDay = (offsetDays = 0) => new Date(Date.now() + 9 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
const today = jstDay();
const browser = await chromium.launch();
const errors = [];
const open = async (url, opts) => {
  const page = await (await browser.newContext(opts)).newPage();
  page.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(`${url}: ${m.text()}`));
  await page.goto(sys.base + url);
  return page;
};
const staffLogin = async (staff) => {
  const page = await open('/staff.html', { viewport: { width: 1280, height: 860 } });
  await page.fill('#loginForm [name=email]', staff.id);
  await page.fill('#loginForm [name=password]', staff.password);
  await page.click('#loginForm button[type=submit]');
  return page;
};

try {
  const adminAcc = makeStaff('kanri', '管理 花子', 'admin');
  const auctAcc = makeStaff('shinko', '進行 次郎', 'auctioneer');

  console.log('スタッフ');
  const admin = await staffLogin(adminAcc);
  await shot(admin, 'mvp-01-staff-login');
  await admin.waitForSelector('#tabs button');
  check((await admin.textContent('#who')).includes('主催者管理者'), '主催者管理者としてログインできる');
  check((await admin.locator('#tabs button').count()) === 9, '主催者管理者には、9 の区分が出る');

  // 設定
  await admin.click('#tabs [data-key=settings]');
  await admin.fill('[name=shippingNotice]', '落札価格に送料は含まれません。送料は別にご請求します。');
  await admin.click('#panel button[type=submit]');
  await admin.waitForSelector('#panel .msg.ok');
  check(true, '送料の表示を保存できる');

  // 開催のない日のトップページ
  // トップページは、ログインした人にだけ出る（ログインしていない人は、ログインの画面へ送られる）。ここでは、主催者管理者として開く
  const quiet = await admin.context().newPage();
  await quiet.goto(sys.base + '/');
  await quiet.waitForSelector('#nextList li');
  check((await quiet.isHidden('#today')) && (await quiet.textContent('#nextList')).includes('次の開催は、まだ決まっていません'), '開催のない日は、次の開催の一覧だけを出す（決まっていなければ、そう知らせる）');
  await shot(quiet, 'mvp-05-top-no-event');

  // 開催
  await admin.click('#tabs [data-key=events]');
  await admin.click('text=開催を作る');
  await admin.fill('#dlg [name=title]', '12月の競り（検証）');
  await admin.fill('#dlg [name=startsAt]', `${today}T09:00`);
  await admin.fill('#dlg [name=endsAt]', `${today}T18:00`);
  await admin.fill('#dlg [name=venueName]', '検証会場');
  await admin.fill('#dlg [name=venueAddress]', '埼玉県◯◯市1-2-3');
  await admin.fill('#dlg [name=highlights]', '防水シート\n飯ごう\n寝袋');
  await admin.click('#dlg button[type=submit]');
  await admin.waitForSelector('#panel table');
  await admin.click('#panel >> text=公開する');
  await admin.waitForFunction(() => document.querySelector('#line')?.textContent.includes('届出済み'));
  check(true, '届出済みの印がない開催は、公開できない（理由が画面に出る）');
  await admin.click('#panel >> text=編集');
  await admin.check('#dlg [name=notified]');
  await admin.click('#dlg button[type=submit]');
  await admin.waitForFunction(() => !document.querySelector('#dlg').open);
  await admin.click('#panel >> text=公開する');
  await admin.waitForSelector('#panel .state[data-on="1"]');
  check(true, '届出済みにすると、公開できる');
  await shot(admin, 'mvp-02-events');

  // 進行役には、受付と未引き取りだけ（商品は、進行コンソールでその場で登録する）
  const auct = await staffLogin(auctAcc);
  await auct.waitForSelector('#tabs button');
  check((await auct.locator('#tabs button').count()) === 2, '進行役の管理画面には、受付・未引き取りだけが出る');

  console.log('その場での登録（進行コンソール）');
  // 進行コンソールは、スタッフのログインで入る（合言葉つきの URL は使わない）
  const anon = await open('/console.html', { viewport: { width: 1280, height: 860 } });
  await anon.waitForURL(/staff\.html\?next=console/);
  check(true, 'ログインしていない人が進行コンソールを開くと、スタッフのログインへ進む');
  const con = await auct.context().newPage();
  con.on('pageerror', (e) => errors.push(`console: ${e.message}`));
  await con.setViewportSize({ width: 1280, height: 1100 });
  await con.goto(sys.base + '/console.html');
  await con.waitForSelector('#eventBar:not([hidden])');
  check((await con.textContent('#evTitle')).includes('12月の競り') && (await con.textContent('#evPhase')) === '開始前', '進行役がログインで入れる。開催の名前と「開始前」が出る');
  await con.fill('#newTitle', '防水シート（検証）'); await con.fill('#newPrice', '9500');
  await con.click('#addLot button[type=submit]');
  await con.waitForFunction(() => document.body.textContent.includes('防水シート（検証）'));
  check(true, '進行コンソールから、その場で登録できる');
  await shot(con, 'mvp-03-console-add');

  console.log('トップページ（開催の当日）');
  // 2週間後の開催も公開しておく（月に2〜3回の開催）
  const later = jstDay(14);
  const made = await admin.evaluate(async (day) => {
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const { id } = await post('/api/events', { title: '次回の競り（検証）', startsAt: `${day}T10:00`, endsAt: `${day}T17:00`, venueName: '検証会場', venueAddress: '埼玉県◯◯市1-2-3', notified: true });
    return post(`/api/events/${id}/publish`, {});
  }, later);
  check(made.ok, '2つめの開催を公開できる');
  const top = await admin.context().newPage();
  await top.goto(sys.base + '/');
  await top.waitForSelector('#today:not([hidden])');
  const hero = await top.textContent('#today');
  check(hero.includes('本日開催') && hero.includes('12月の競り（検証）') && hero.includes('9:00 〜 18:00'), '開催の当日は、開催の名前と時間を大きく出す');
  check(hero.includes('本日の目玉商品') && hero.includes('防水シート') && hero.includes('寝袋'), '本日の目玉商品を出す');
  const go = await top.locator('.today__go').boundingBox();
  check(go.height >= 52 && go.width >= 300, `「参加する」ボタンが大きい（${Math.round(go.width)}×${Math.round(go.height)}px）`);
  const order = await top.evaluate(() => document.querySelector('#today').compareDocumentPosition(document.querySelector('.next')) & Node.DOCUMENT_POSITION_FOLLOWING);
  check(!!order, '次の開催の一覧は、当日の案内の下に出る');
  await top.waitForFunction(() => document.querySelector('#nextList').textContent.includes('次回の競り（検証）'));
  check(!(await top.textContent('#nextList')).includes('12月の競り（検証）'), '2週間後の開催が、次の開催の一覧に出る（今日の開催は、上の案内にだけ出す）');
  await shot(top, 'mvp-06-top-event-day', { fullPage: true });
  await top.setViewportSize({ width: 390, height: 844 });
  await top.waitForSelector('#terms:not([hidden])');
  check((await top.textContent('main')).includes('送料は含まれません'), '送料が含まれないことと、返品特約を表示する');
  check((await top.textContent('main')).includes('買歩銭（落札額の10%）がかかります'), 'トップページに、買歩銭がかかることを表示する');
  check(await top.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'スマホの幅で、横にはみ出さない');
  await shot(top, 'mvp-04-top-phone', { fullPage: true });

  console.log('最初のページ（ログイン）と、会員登録');
  const phone = await open('/', devices['iPhone 13']);
  await phone.waitForURL(/login\.html/);
  check(await phone.isVisible('#pwForm [name=loginId]') && await phone.isVisible('#pwForm [name=password]'), 'ログインしていない人が最初に開くのは、ログイン ID とパスワードのログインの画面');
  check((await phone.textContent('main')).includes('会員登録がお済みでない方'), 'ログインの画面の下に、会員登録への案内が出る');
  await shot(phone, 'mvp-04b-login', { fullPage: true });
  await phone.click('main a[href="/register.html"]');
  await phone.waitForSelector('#stepPhone');
  await phone.fill('[name=id]', '123');
  await phone.click('#stepPhone button[type=submit]');
  await phone.waitForFunction(() => document.querySelector('#stepPhone .msg').textContent.length > 0);
  check(true, '電話番号の誤りは、理由を出す');
  await phone.fill('[name=id]', '090-0000-1111');
  await phone.click('#stepPhone button[type=submit]');
  await phone.waitForSelector('#stepCode:not([hidden])');
  await shot(phone, 'mvp-08-register-code');
  await phone.fill('[name=code]', lastCode() === '000000' ? '111111' : '000000');
  await phone.waitForFunction(() => document.querySelector('#stepCode .msg').textContent.includes('あと 4 回'));
  check(true, '認証番号の誤りは、残りの回数を出す');
  await phone.fill('[name=code]', lastCode());
  await phone.waitForSelector('#stepProfile:not([hidden])');
  await phone.fill('[name=lastName]', '検証'); await phone.fill('[name=firstName]', '太郎');
  await phone.fill('[name=lastKana]', 'ケンショウ'); await phone.fill('[name=firstKana]', 'タロウ');
  await phone.type('[name=postalCode]', '1000001');
  await phone.waitForFunction(() => document.querySelector('[name=prefecture]').value !== '');
  await phone.type('[name=address1]', '1-1');
  await phone.fill('[name=email]', 'taro@example.com');
  await phone.click('#stepProfile button[type=submit]');
  await phone.waitForSelector('#adultRow [aria-invalid=true]');
  check(true, '個人は、18歳以上の確認がないと登録できない');
  await shot(phone, 'mvp-09-register-profile', { fullPage: true });
  await phone.check('[name=adult]');
  await phone.click('#stepProfile button[type=submit]');
  await phone.waitForSelector('#agreeRow [aria-invalid=true]');
  check(true, '規約に同意しないと、登録できない');
  await phone.check('[name=agreed]');
  await phone.click('#stepProfile button[type=submit]');
  await phone.waitForURL(/mypage\.html/);
  await phone.waitForSelector('#facts dd');
  check((await phone.textContent('#facts')).includes('090-0000-1111'), '登録が済み、マイページに内容が出る');
  check(await phone.isVisible('#emailBanner'), 'メールアドレスが未確認であることを出す');
  await shot(phone, 'mvp-10-mypage');
  const link = /https?:\/\/\S+/.exec(outbox().find((m) => m.channel === 'email').body)[0];
  await phone.goto(link);
  await phone.waitForSelector('#facts dd');
  check(!(await phone.isVisible('#emailBanner')) && (await phone.textContent('#notice')).includes('確認しました'), 'メールのリンクで、確認済みになる');

  console.log('ログイン');
  await phone.goto(sys.base + '/mypage.html#profile'); await phone.click('#logoutBtn'); // スマートフォンでは、ログアウトは、マイページの一覧にある
  await phone.waitForURL(/login\.html/);
  check(true, 'ログアウトすると、ログインの画面に戻る');
  // パスワードを忘れた人: 認証番号で入って、新しいパスワードを決める
  await phone.click('#forgot');
  await phone.fill('[name=id]', '09000001111');
  await phone.click('#stepPhone button[type=submit]');
  await phone.waitForSelector('#stepCode:not([hidden])');
  await phone.fill('[name=code]', lastCode());
  await phone.waitForURL(/mypage\.html/);
  check(true, '電話番号と認証番号で、ログインできる（パスワードを忘れた人）');
  await phone.waitForSelector('#dlg[open]');
  await phone.fill('#dlg [name=loginId]', 'kensho01');
  await phone.fill('#dlg [name=password]', 'kensho-pass-01');
  await phone.fill('#dlg [name=password2]', 'kensho-pass-01');
  await phone.click('#dlg button[type=submit]');
  await phone.waitForFunction(() => document.getElementById('notice').textContent.includes('パスワードを保存しました'));
  await phone.goto(sys.base + '/mypage.html#profile'); await phone.click('#logoutBtn'); // スマートフォンでは、ログアウトは、マイページの一覧にある
  await phone.waitForURL(/login\.html/);
  await phone.fill('#pwForm [name=loginId]', 'kensho01');
  await phone.fill('#pwForm [name=password]', 'chigau');
  await phone.click('#pwForm button[type=submit]');
  await phone.waitForFunction(() => document.querySelector('#pwForm .msg').textContent.includes('違います'));
  await phone.fill('#pwForm [name=password]', 'kensho-pass-01');
  await phone.click('#pwForm button[type=submit]');
  await phone.waitForURL(sys.base + '/');
  check(await phone.isVisible('#nextList'), 'ログイン ID とパスワードでログインでき、トップページが開く');
  await phone.goto(sys.base + '/mypage.html');

  console.log('参加手続きと入札');
  await phone.click('.tabbar a[href="/bidder.html"]');
  await phone.waitForSelector('#modePick:not([hidden])');
  check((await phone.locator('[data-pick]').count()) === 2 && await phone.isHidden('#join'), '参加の前に、オンラインか会場かの2択が出る');
  await phone.click('[data-pick=venue]');
  await phone.waitForSelector('#join:not([hidden])');
  check(await phone.isEnabled('#join [name=payment][value=cash]'), '会場を選ぶと、当日現金が選べる');
  await phone.click('#backToMode');
  await phone.click('[data-pick=online]');
  await phone.waitForSelector('#join:not([hidden])');
  check(await phone.isDisabled('#join [name=payment][value=cash]') && (await phone.textContent('#gateEvent')).includes('オンライン参加'), '選び直して、オンラインにできる');
  check((await phone.locator('#join input:checked').count()) === 0, '受け取り方法と支払方法は、どちらも選ばれていない状態で聞く');
  check(await phone.isHidden('#enter'), '答えるまで、入札画面に進むボタンは出ない');
  await phone.waitForFunction(() => document.getElementById('joinTerms').textContent.includes('買歩銭'));
  check(true, '参加手続きの画面に、買歩銭がかかることを表示する');
  await phone.check('#join [name=receive][value=ship]');
  await phone.click('#join button[type=submit]');
  await phone.waitForFunction(() => document.querySelector('#join .pickerr')?.textContent.includes('支払方法を選んでください'));
  check((await phone.$$('#join .pickerr')).length === 1, '片方だけでは進めない（選んでいない欄のすぐ下に、理由を出す）');
  await shot(phone, 'mvp-13-join');
  await phone.check('#join [name=payment][value=transfer]');
  await phone.click('#join button[type=submit]');
  await phone.waitForFunction(() => document.getElementById('gate').style.display === 'none');
  check((await phone.textContent('#gateEvent')).includes('参加番号1'), '手続きが済むと、参加番号 1 が振られ、そのまま入札画面に入る');
  await con.click('#b_next');
  await con.waitForFunction(() => document.getElementById('status').textContent.includes('受付中'), null, { timeout: 15000 });
  await phone.waitForFunction(() => document.getElementById('bid').textContent === '入札');
  await phone.click('#bid');
  await con.waitForFunction(() => document.getElementById('history').textContent.includes('9,500'));
  check((await phone.textContent('#priceTotal')).includes('買歩銭（10%）込み ¥10,450'), '入札画面の価格の下に、買歩銭を足した金額を出す');
  check(true, '登録した会員が、参加番号で入札できる');
  await shot(phone, 'mvp-15-bid');

  console.log('会場参加（QR コード → 会員登録 → 参加手続き → 来場確認）');
  await admin.click('#tabs [data-key=reception]');
  await admin.waitForSelector('#panel table');
  await admin.click('#panel >> text=会場の QR コード');
  await admin.waitForFunction(() => { const i = document.querySelector('#dlg img.qr'); return i && i.complete && i.naturalWidth > 0; });
  check(true, '受付の画面で、会場の QR コードを出せる');
  await shot(admin, 'mvp-16-venue-qr');
  await admin.click('#dlg >> text=閉じる');
  const venueUrl = await admin.evaluate(() => fetch('/api/reception').then((r) => r.json()).then((j) => j.event.venueUrl));
  const guest = await (await browser.newContext(devices['iPhone 13'])).newPage();
  guest.on('pageerror', (e) => errors.push(`venue: ${e.message}`));
  await guest.goto(venueUrl); // QR コードを読み取った
  await guest.waitForURL(/login\.html\?next=bidder/);
  await guest.click('main a[href*="register.html"]');
  await guest.fill('[name=id]', '090-0000-2222');
  await guest.click('#stepPhone button[type=submit]');
  await guest.waitForSelector('#stepCode:not([hidden])');
  await guest.fill('[name=code]', lastCode());
  await guest.waitForSelector('#stepProfile:not([hidden])');
  await guest.fill('[name=lastName]', '会場'); await guest.fill('[name=firstName]', '花子');
  await guest.fill('[name=lastKana]', 'カイジョウ'); await guest.fill('[name=firstKana]', 'ハナコ');
  await guest.type('[name=postalCode]', '3320012');
  await guest.waitForFunction(() => document.querySelector('[name=prefecture]').value !== '');
  await guest.type('[name=address1]', '4-5-6');
  await guest.fill('[name=email]', 'hanako@example.com');
  await guest.check('[name=adult]');
  await guest.check('[name=agreed]');
  await guest.click('#stepProfile button[type=submit]');
  await guest.waitForSelector('#join:not([hidden])');
  check(!new URL(guest.url()).search, '登録のあと、入札画面の参加手続きに進む（URL に合言葉を残さない）');
  check((await guest.textContent('#gateEvent')).includes('会場参加') && (await guest.isEnabled('#join [name=payment][value=cash]')), '会場参加の手続きでは、当日現金を選べる');
  await guest.check('#join [name=receive][value=pickup]');
  await guest.check('#join [name=payment][value=cash]');
  await shot(guest, 'mvp-17-venue-join');
  await guest.click('#join button[type=submit]');
  await guest.waitForFunction(() => document.getElementById('gateWait').textContent.includes('札'));
  check((await guest.textContent('#gateEvent')).includes('参加番号2') && (await guest.isHidden('#enter')), '参加番号 2 が振られ、来場確認までは入れない');
  await shot(guest, 'mvp-18-venue-wait');
  await admin.click('#tabs [data-key=reception]'); // 受付は、ひらき直すか 15 秒ごとに読み直す（「更新」のボタンはなくした）
  await admin.waitForSelector('#panel >> text=確認待ち 1 人');
  await shot(admin, 'mvp-19-reception');
  await admin.click('#panel td.act >> text=来場を確認');
  await admin.waitForSelector('#panel >> text=確認待ち 0 人');
  await guest.waitForSelector('#enter:not([hidden])', { timeout: 15000 });
  check(true, '受付係が来場を確認すると、本人の画面が自動で進めるようになる');
  await guest.click('#enter');
  await guest.waitForFunction(() => document.getElementById('bid').textContent === '入札');
  check(await guest.isDisabled('#showVideo'), '会場参加の画面には、映像を出さない');
  await guest.click('#bid');
  await con.waitForFunction(() => document.getElementById('history').textContent.includes('10,000'));
  check(true, '会場参加の人が、同じ競りに入札できる');
  await con.waitForFunction(() => document.getElementById('presenceSplit').textContent.includes('会場 1・オンライン 1'));
  check(true, '進行コンソールに、会場とオンラインの人数が出る');
  await shot(guest, 'mvp-20-venue-bidder', { fullPage: true });
  // オンライン参加の人を、受付で会場参加に切り替える
  await admin.click('#tabs [data-key=reception]');
  await admin.click('#panel td.act >> text=会場参加に切り替え');
  await admin.click('#dlg button[type=submit]');
  await admin.waitForFunction(() => document.querySelector('#dlg .msg')?.textContent.includes('支払方法'));
  await admin.check('#dlg [name=payment][value=cash]');
  await admin.click('#dlg button[type=submit]');
  await admin.waitForFunction(() => document.querySelectorAll('#panel .state[data-on="1"]').length === 2);
  check(true, 'オンライン参加の人を、支払方法を選び直して、会場参加に切り替えられる');

  console.log('会場の大型モニター');
  const mon = await admin.context().newPage();
  mon.on('pageerror', (e) => errors.push(`monitor: ${e.message}`));
  await mon.setViewportSize({ width: 1600, height: 900 });
  await mon.goto(sys.base + '/monitor.html');
  await mon.waitForFunction(() => document.getElementById('price').textContent.includes('10,000'));
  check((await mon.textContent('#who')).includes('最高入札者 2番') && (await mon.textContent('#title')).includes('防水シート'), '会場モニターに、品名・現在価格・最高入札者の参加番号が大きく出る');
  check((await mon.locator('#history li').count()) === 2, '会場モニターに、入札の履歴が出る');
  await shot(mon, 'mvp-28-monitor');
  const anonMon = await open('/monitor.html');
  await anonMon.waitForURL(/staff\.html\?next=monitor/);
  check(true, 'ログインしていない人が会場モニターを開くと、スタッフのログインへ進む');

  console.log('進行: 代理入札・取り消し・締め・休憩・開催終了');
  check((await con.textContent('#evPhase')) === '進行中', '競りを始めると、開催が「進行中」になる');
  await con.click('#proxyBox summary');
  await con.fill('#pxPaddle', '1');
  await con.fill('#pxAmount', '11000');
  await con.click('#proxyForm button[type=submit]');
  await con.waitForFunction(() => document.getElementById('pxMsg').textContent.includes('札を確認'));
  check(true, '札の確認のチェックがないと、代理入札できない（理由は、代理入札の欄のすぐ下に出る）');
  await con.check('#pxCard');
  await con.click('#proxyForm button[type=submit]');
  await con.waitForFunction(() => document.getElementById('history').textContent.includes('1番（代理）'));
  await guest.waitForFunction(() => document.getElementById('history').textContent.includes('1番（代理）'));
  check(true, '代理入札が受理され、全員の履歴に「代理」と出る');
  await shot(con, 'mvp-21-console-proxy', { fullPage: true });
  await con.click('#history >> text=代理入札を取り消す');
  await con.fill('#dlgReason', '金額の入力の誤り');
  await con.click('#dlgOk');
  await con.waitForFunction(() => document.getElementById('price').textContent.includes('10,000'));
  await guest.waitForFunction(() => document.querySelector('#right')?.classList.contains('on'));
  check(!(await guest.evaluate(() => document.body.classList.contains('outbid'))) && (await guest.textContent('#msg')).includes('最高入札者に戻りました'), '権利が戻った人の画面から、上回られた警告が消える');
  check(true, '代理入札を取り消すと、現在価格が1つ前に戻り、前の最高入札者に権利表示が戻る');
  await con.click('#b_close'); await con.click('#dlgOk'); // 締めは確かめてから
  await con.waitForFunction(() => document.getElementById('sold').textContent.includes('10,000'));
  const soldRow = await con.textContent('#sold');
  check(soldRow.includes('2番') && soldRow.includes('現地受け取り') && soldRow.includes('当日現金'), '落札一覧に、参加番号・落札額・受け取り方法・支払方法が出る');
  // 当日現金の精算（受付）→ 請求書（領収書を兼ねる）→ 引き渡し
  await admin.click('#tabs [data-key=billing]');
  await admin.waitForFunction(() => { const t = document.querySelector('#panel table')?.textContent ?? ''; return t.includes('未精算') && t.includes('当日現金'); });
  check((await admin.textContent('#panel table')).includes('¥11,000') && (await admin.textContent('#panel table')).includes('落札 ¥10,000＋買歩銭 ¥1,000'), '落札すると、請求の画面に「未精算」の明細が出る。金額は、落札額＋買歩銭10%');
  await admin.check('#panel table input[type=checkbox]');
  await shot(admin, 'mvp-24-billing-settle');
  await admin.click('#panel >> text=1件を、当日現金で精算');
  await admin.waitForSelector('#dlg[open]');
  check(/請求書（領収書を兼ねる）\d{8}-0001 を発行しました/.test(await admin.textContent('#dlg')), '精算すると、請求書（領収書を兼ねる）を発行する');
  const pdfUrl = await admin.getAttribute('#dlg a', 'href');
  const pdf = await admin.evaluate(async (u) => { const r = await fetch(u); const b = new Uint8Array(await r.arrayBuffer()); return { type: r.headers.get('content-type'), head: String.fromCharCode(...b.slice(0, 5)) }; }, pdfUrl);
  check(pdf.type === 'application/pdf' && pdf.head === '%PDF-', '請求書の PDF を開ける');
  await admin.click('#dlg >> text=閉じる');
  await admin.waitForSelector('#panel td.act >> text=引き渡し');
  await admin.click('#panel td.act >> text=引き渡し');
  await admin.waitForSelector('#dlg[open] >> text=引き渡しますか');
  check(await admin.evaluate(() => document.activeElement?.textContent === 'やめる'), '引き渡しは、だれに何を渡すかを書いて確かめる（最初のフォーカスは「やめる」）');
  await admin.click('#dlg >> button:has-text("引き渡す")');
  await admin.waitForSelector('#panel >> text=引き渡し済み');
  check(true, '消し込みのあとに、引き渡しを記録できる');
  await shot(admin, 'mvp-25-billing', { fullPage: true });
  await guest.goto(sys.base + '/mypage.html');
  await guest.waitForSelector('#invoices .invitems');
  const mine = await guest.textContent('#invoices .invitems');
  check(mine.includes('¥11,000') && mine.includes('買歩銭 ¥1,000'), 'マイページの請求書の中に、買歩銭を含めた金額と内訳が出る');
  check(mine.includes('防水シート') && mine.includes('お渡し済み'), '落札者のマイページに、品・状態が出る（請求書の中に）');
  check(await guest.isHidden('#billing'), '請求書になった品は、「落札した品」に二度出さない');
  const invs = await guest.textContent('#invoices');
  check(/\d{8}-0001/.test(invs) && invs.includes('¥11,000') && invs.includes('お支払い済み') && invs.includes('請求書を開く'), 'マイページの「請求書」に、請求番号・金額・状態と、PDF を開くボタンが出る');
  await guest.evaluate(() => { location.hash = '#profile'; });
  check(await guest.isVisible('#facts') && await guest.isHidden('#invoices'), '「個人情報の設定」のタブに切り替えられる');
  await guest.evaluate(() => { location.hash = '#bills'; });
  await shot(guest, 'mvp-26-mypage-billing', { fullPage: true });
  await guest.goto(sys.base + '/bidder.html');
  await guest.waitForSelector('#modePick:not([hidden])');
  check((await guest.textContent('#pickNow')).includes('会場参加') && await guest.isHidden('#enter'), '手続きが済んだ人にも、入るたびに、オンラインか会場かの2択が出る（いまの参加のしかたつき）');
  await guest.click('[data-pick=venue]');
  await guest.waitForFunction(() => document.getElementById('bid').textContent.length > 0);
  check(await guest.isHidden('#gate'), 'いまと同じほうを選ぶと、そのまま入札の画面に入る');
  await admin.click('#tabs [data-key=fees]');
  await admin.waitForFunction(() => { const t = document.querySelector('#panel .facts')?.textContent ?? ''; return t.includes('¥10,000') && t.includes('¥550'); });
  check(true, '手数料の集計: 対象 10,000円 → 手数料 500円 ＋ 消費税 50円');
  await shot(admin, 'mvp-27-fees', { fullPage: true });

  await con.click('#b_break'); // 次の開始予定の時刻は、押したときのダイアログで聞く
  await con.fill('#dlgReason', '13:00');
  await con.click('#dlgOk');
  await guest.waitForFunction(() => document.getElementById('eventNote').textContent.includes('13:00'));
  await con.waitForFunction(() => document.getElementById('evPhase').textContent.includes('休憩中'));
  check(true, '休憩に入ると、参加者の画面に再開の予定時刻が出る');
  await shot(guest, 'mvp-22-bidder-break');
  await shot(con, 'mvp-23-console-event', { fullPage: true });
  await con.click('#b_end');
  await con.waitForSelector('#dlg[open]');
  check((await con.textContent('#dlgBody')).includes('取り消せません'), '開催終了の前に、取り消せないことを確かめる');
  await con.click('#dlgOk');
  await guest.waitForFunction(() => document.getElementById('eventNote').textContent.includes('終了しました'));
  await con.waitForSelector('#eventBar', { state: 'hidden' });
  check(true, '開催を終了すると、参加者の画面に終了の知らせが出る');
  const after = await admin.context().newPage();
  await after.goto(sys.base + '/');
  await after.waitForSelector('#nextList li');
  check(await after.isHidden('#today'), '終了した開催は、トップページの「本日開催」に出ない');
  check(await after.isHidden('#wins'), '落札していない人（スタッフ）には、落札の結果を出さない');
  await guest.goto(sys.base + '/');
  await guest.waitForSelector('#wins:not([hidden])');
  const wins = await guest.textContent('#wins');
  check(wins.includes('落札結果') && wins.includes('防水シート') && wins.includes('¥10,000') && wins.includes('¥1,000') && wins.includes('¥11,000') && wins.includes('合計（1点）'), '開催が終わると、トップページに、何をいくらで落札したかの一覧が出る');
  await shot(guest, 'mvp-27-home-wins', { fullPage: true });

  // 会員の停止と、記録
  await admin.click('#tabs [data-key=members]');
  await rowAction(admin, '検証 太郎', '停止'); // 操作が3つ以上の行では「⋯」の中
  await admin.fill('#dlg [name=reason]', '検証のための停止');
  await admin.click('#dlg button[type=submit]');
  await admin.waitForSelector('#panel .warn');
  await shot(admin, 'mvp-11-members');
  await phone.goto(sys.base + '/mypage.html');
  await phone.waitForSelector('#suspended:not([hidden])');
  check(true, '主催者管理者が会員を停止でき、本人の画面に出る');
  await admin.click('#tabs [data-key=audit]');
  await admin.waitForFunction(() => ['会員を停止', '品を登録'].every((t) => document.querySelector('#panel').textContent.includes(t)));
  check(true, '会員の停止と、その場での商品登録が、記録に残る');
  await shot(admin, 'mvp-12-audit');

  console.log('規約・登録内容の変更・スタッフの再発行');
  await admin.click('#tabs [data-key=settings]');
  await admin.waitForSelector('#panel [name=terms]');
  await admin.fill('#panel [name=terms]', '第1条（検証用）\nこの文面は、画面の確認のための仮のものです。');
  await admin.click('#panel >> text=規約類を保存する');
  await admin.waitForFunction(() => [...document.querySelectorAll('#panel .msg.ok')].some((m) => m.textContent.includes('保存しました')));
  const legal = await open('/legal.html#terms', devices['iPhone 13']);
  await legal.waitForFunction(() => document.getElementById('terms')?.textContent.includes('第1条（検証用）'));
  check((await legal.textContent('#tokushoho')).includes('準備中'), '規約のページに、入れた文面が出る。まだ入れていないものは「準備中」と出る');
  await shot(legal, 'mvp-29-legal');
  const reg = await open('/register.html', devices['iPhone 13']);
  await reg.waitForSelector('#agreeRow', { state: 'attached' });
  await reg.waitForFunction(() => !document.getElementById('agreeRow').hidden);
  check(true, '会員登録には、いつも同意の欄が出る');
  // 退会していない方の会員（会場 花子）が、登録内容を変える
  await guest.goto(sys.base + '/mypage.html');
  await guest.evaluate(() => { location.hash = '#profile'; });
  await guest.waitForSelector('#facts dd');
  await guest.click('#editBtn');
  await guest.fill('#dlg [name=address1]', '川口市本町7-8-9');
  await guest.click('#dlg button[type=submit]');
  await guest.waitForFunction(() => document.getElementById('facts')?.textContent.includes('7-8-9'));
  check(true, '会員が、登録内容を変えられる');
  await admin.click('#tabs [data-key=staff]');
  await rowAction(admin, 'shinko', '再発行'); // 操作が3つ以上の行では「⋯」の中
  // 再発行は、本人のログインを切るので、確かめてから（報告書 80 章）。最初のフォーカスは「やめる」
  await admin.waitForSelector('#dlg[open] >> text=再発行しますか');
  check(await admin.evaluate(() => document.activeElement?.textContent === 'やめる'), 'スタッフの再発行は、何が無効になるかを書いて確かめる（最初のフォーカスは「やめる」）');
  await admin.click('#dlg >> button:has-text("再発行する")');
  await admin.waitForFunction(() => { const i = document.querySelector('#dlg img.qr'); return i && i.complete && i.naturalWidth > 0; });
  check((await admin.textContent('#dlg')).includes('認証アプリの鍵'), 'スタッフの認証アプリを再発行でき、QR コードが出る');
  await admin.click('#dlg >> text=渡したので閉じる');

  // 幅の確認（横にはみ出さない）
  for (const url of ['/', '/register.html', '/login.html']) {
    const narrow = await open(url, { viewport: { width: 320, height: 640 } });
    await narrow.waitForLoadState('networkidle');
    check(await narrow.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `幅 320px で、横にはみ出さない: ${url}`);
  }
  check(errors.length === 0, `画面のエラーがない${errors.length ? ': ' + errors.join(' / ') : ''}`);
  console.log('\nすべて確認しました');
} catch (err) {
  console.error(err.message);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  sys.stop();
}
