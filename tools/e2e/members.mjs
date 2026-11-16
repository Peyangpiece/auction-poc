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
const lastCode = () => /認証番号は (\d{6})/.exec(outbox().filter((m) => m.channel === 'sms').at(-1).body)[1];

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
  await page.fill('[name=loginId]', staff.id);
  await page.fill('[name=password]', staff.password);
  await page.fill('[name=code]', totp(staff.secret));
  return page;
};

try {
  const adminAcc = makeStaff('kanri', '管理 花子', 'admin');
  const auctAcc = makeStaff('shinko', '進行 次郎', 'auctioneer');

  console.log('スタッフ');
  const admin = await staffLogin(adminAcc);
  await shot(admin, 'mvp-01-staff-login');
  await admin.click('#loginForm button[type=submit]');
  await admin.waitForSelector('#tabs button');
  check((await admin.textContent('#who')).includes('主催者管理者'), '主催者管理者としてログインできる');
  check((await admin.locator('#tabs button').count()) === 6, '主催者管理者には、6つの画面が出る（商品の事前登録はない）');

  // 設定
  await admin.click('#tabs [data-key=settings]');
  await admin.fill('[name=shippingNotice]', '落札価格に送料は含まれません。送料は別にご請求します。');
  await admin.click('#panel button[type=submit]');
  await admin.waitForSelector('#panel .msg.ok');
  check(true, '送料の表示を保存できる');

  // 開催
  await admin.click('#tabs [data-key=events]');
  await admin.click('text=開催を作る');
  await admin.fill('#dlg [name=title]', '12月の競り（検証）');
  await admin.fill('#dlg [name=startsAt]', '2026-12-05T09:00');
  await admin.fill('#dlg [name=endsAt]', '2026-12-05T16:00');
  await admin.fill('#dlg [name=venueName]', '検証会場');
  await admin.fill('#dlg [name=venueAddress]', '埼玉県◯◯市1-2-3');
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

  // 進行役には、SMS の制限だけ（商品は、進行コンソールでその場で登録する）
  const auct = await staffLogin(auctAcc);
  await auct.click('#loginForm button[type=submit]');
  await auct.waitForSelector('#tabs button');
  check((await auct.locator('#tabs button').count()) === 1, '進行役の管理画面には、SMS の制限だけが出る');

  console.log('その場での登録（進行コンソール）');
  const con = await open(`/console.html?t=${sys.tokens.auctioneer}`, { viewport: { width: 1280, height: 860 } });
  await con.waitForSelector('#addLot');
  await con.fill('#newTitle', '防水シート（検証）');
  await con.click('#addLot button[type=submit]');
  await con.waitForFunction(() => document.body.textContent.includes('防水シート（検証）'));
  check(true, '進行コンソールから、その場で登録できる');
  await shot(con, 'mvp-03-console-add');

  console.log('トップページ');
  const phone = await open('/', devices['iPhone 13']);
  await phone.waitForSelector('#terms:not([hidden])');
  check((await phone.textContent('main')).includes('送料は含まれません'), '送料が含まれないことと、返品特約を表示する');
  await shot(phone, 'mvp-04-top-phone');

  console.log('会員登録');
  await phone.click('#lead a[href="/register.html"]');
  await phone.waitForSelector('#stepPhone');
  await phone.fill('[name=phone]', '123');
  await phone.click('#stepPhone button[type=submit]');
  await phone.waitForFunction(() => document.querySelector('#stepPhone .msg').textContent.length > 0);
  check(true, '電話番号の誤りは、理由を出す');
  await phone.fill('[name=phone]', '090-0000-1111');
  await phone.click('#stepPhone button[type=submit]');
  await phone.waitForSelector('#stepCode:not([hidden])');
  await shot(phone, 'mvp-08-register-code');
  await phone.fill('[name=code]', lastCode() === '000000' ? '111111' : '000000');
  await phone.click('#stepCode button[type=submit]');
  await phone.waitForFunction(() => document.querySelector('#stepCode .msg').textContent.includes('あと 4 回'));
  check(true, '認証番号の誤りは、残りの回数を出す');
  await phone.fill('[name=code]', lastCode());
  await phone.click('#stepCode button[type=submit]');
  await phone.waitForSelector('#stepProfile:not([hidden])');
  await phone.fill('[name=name]', '検証 太郎');
  await phone.fill('[name=email]', 'taro@example.com');
  await phone.fill('[name=address]', '東京都千代田区1-1');
  await phone.click('#stepProfile button[type=submit]');
  await phone.waitForSelector('#adultRow [aria-invalid=true]');
  check(true, '個人は、18歳以上の確認がないと登録できない');
  await shot(phone, 'mvp-09-register-profile', { fullPage: true });
  await phone.check('[name=adult]');
  await phone.click('#stepProfile button[type=submit]');
  await phone.waitForURL(/mypage\.html/);
  await phone.waitForSelector('#facts dd');
  check((await phone.textContent('#facts')).includes('09000001111'), '登録が済み、マイページに内容が出る');
  check(await phone.isVisible('#emailBanner'), 'メールアドレスが未確認であることを出す');
  await shot(phone, 'mvp-10-mypage');
  const link = /https?:\/\/\S+/.exec(outbox().find((m) => m.channel === 'email').body)[0];
  await phone.goto(link);
  await phone.waitForSelector('#facts dd');
  check(!(await phone.isVisible('#emailBanner')) && (await phone.textContent('#notice')).includes('確認しました'), 'メールのリンクで、確認済みになる');

  console.log('ログイン');
  await phone.click('#nav >> text=ログアウト');
  await phone.waitForURL(sys.base + '/');
  await phone.click('#nav >> text=ログイン');
  await phone.fill('[name=phone]', '09000001111');
  await phone.click('#stepPhone button[type=submit]');
  await phone.waitForSelector('#stepCode:not([hidden])');
  await phone.fill('[name=code]', lastCode());
  await phone.click('#stepCode button[type=submit]');
  await phone.waitForURL(/mypage\.html/);
  check(true, '電話番号と認証番号で、ログインできる');

  // 会員の停止と、記録
  await admin.click('#tabs [data-key=members]');
  await admin.click('#panel >> text=停止');
  await admin.fill('#dlg [name=reason]', '検証のための停止');
  await admin.click('#dlg button[type=submit]');
  await admin.waitForSelector('#panel .warn');
  await shot(admin, 'mvp-11-members');
  await phone.reload();
  await phone.waitForSelector('#suspended:not([hidden])');
  check(true, '主催者管理者が会員を停止でき、本人の画面に出る');
  await admin.click('#tabs [data-key=audit]');
  await admin.waitForFunction(() => ['member.suspend', 'lot.create'].every((t) => document.querySelector('#panel').textContent.includes(t)));
  check(true, '会員の停止と、その場での商品登録が、記録に残る');
  await shot(admin, 'mvp-12-audit');

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
