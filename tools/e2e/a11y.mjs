#!/usr/bin/env node
// 画面のアクセシビリティの実測（axe-core。WCAG 2.1 A・AA と、推奨の決まり）。
// 一時フォルダにサーバーを立て、明るい配色と暗い配色の両方で、全画面を開いて調べる。違反が1つでもあれば、失敗で終わる。
//   npm run test:a11y
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 18097, B = `http://127.0.0.1:${PORT}`;
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'auction-a11y-'));
const env = { ...process.env, PORT: String(PORT), POC_DATA_DIR: D, POC_DEV_SHOW_CODES: '1', POC_IVS_MODE: 'always-live', POC_AUTH_RATE: '0', POC_AUTO_APPROVE: '1' };
execFileSync('node', ['tools/setup-first.js', '--with-event'], { cwd: ROOT, env, stdio: 'ignore' });
const server = spawn('node', ['server/src/index.js'], { cwd: ROOT, env, stdio: 'ignore' });
// 途中で失敗しても、立てたサーバーを残さない（残ると、次の実行が古いサーバーにつながって、失敗する）
process.on('exit', () => { server.kill(); fs.rmSync(D, { recursive: true, force: true }); });
for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch { /* まだ */ } await new Promise((r) => setTimeout(r, 250)); }
const axeSrc = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const br = await chromium.launch();
const post = async (c, u, data) => (await c.request.post(B + u, { data, headers: { origin: B } })).json();
const out = [];
const scan = async (page, name, scheme) => {
  await page.addScriptTag({ content: axeSrc });
  const r = await page.evaluate(async () => (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } })).violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, ex: v.nodes.slice(0, 2).map((x) => x.target.join(' ') + ' | ' + (x.any[0]?.message ?? x.all[0]?.message ?? x.none[0]?.message ?? '').slice(0, 110)) })));
  for (const v of r) out.push({ page: name, scheme, ...v });
};
for (const scheme of ['light', 'dark']) {
  const mk = (vp) => br.newContext({ viewport: vp, colorScheme: scheme, bypassCSP: true });
  // ログイン前
  let c = await mk({ width: 390, height: 844 });
  for (const [n, u] of [['home', '/'], ['register', '/register.html'], ['login', '/login.html'], ['legal', '/legal.html'], ['404', '/nai.html']]) { const p = await c.newPage(); await p.goto(B + u); await p.waitForTimeout(700); await scan(p, n, scheme); await p.close(); }
  // 会員
  const phone = scheme === 'light' ? '09012340001' : '09012340002';
  const s = await post(c, '/api/register/start', { id: phone });
  await post(c, '/api/register/verify', { id: phone, code: s.devCode });
  let p = await c.newPage(); await p.goto(B + '/register.html'); await p.waitForSelector('#stepProfile:not([hidden])'); await p.click('#stepProfile button[type=submit]'); await p.waitForTimeout(500); await scan(p, 'register-profile(errors)', scheme); await p.close();
  await post(c, '/api/register/complete', { kind: 'b2c', name: '確認 太郎', email: `${phone}@example.com`, address: '（例）住所1-1', adult: true });
  p = await c.newPage(); await p.goto(B + '/'); await p.waitForTimeout(700); await scan(p, 'home-member', scheme); await p.close();
  p = await c.newPage(); await p.goto(B + '/mypage.html'); await p.waitForTimeout(800); await scan(p, 'mypage-bills', scheme); await p.click('[data-tab=profile]'); await p.waitForTimeout(300); await scan(p, 'mypage-profile', scheme); await p.click('#editBtn'); await p.waitForTimeout(400); await scan(p, 'mypage-edit-dialog', scheme); await p.close();
  p = await c.newPage(); await p.goto(B + '/bidder.html'); await p.waitForTimeout(900); await scan(p, 'bidder-gate-pick', scheme);
  await p.click('[data-pick=online]'); await p.waitForTimeout(400);
  if (await p.isVisible('#join')) { await scan(p, 'bidder-gate-join', scheme); await p.check('[name=receive][value=ship]'); await p.check('[name=payment][value=transfer]'); await p.click('#join button[type=submit]'); }
  await p.waitForSelector('#modeLine:not([hidden])'); await scan(p, 'bidder-idle', scheme);
  // スタッフ
  const sc = await mk({ width: 1280, height: 900 });
  let sp = await sc.newPage(); await sp.goto(B + '/staff.html'); await sp.waitForTimeout(700); await scan(sp, 'staff-login', scheme); await sp.close();
  const password = fs.readFileSync(D + '/staff-initial-admin.txt', 'utf8').match(/仮のパスワード: (\S+)/)[1];
  await post(sc, '/api/staff/login', { email: 'admin', password });
  sp = await sc.newPage(); await sp.goto(B + '/staff.html'); await sp.waitForTimeout(1000);
  const n = await sp.locator('#tabs button').count();
  for (let i = 0; i < n; i++) { await sp.click(`#tabs button:nth-child(${i + 1})`); await sp.waitForTimeout(600); await scan(sp, 'staff-tab-' + (await sp.textContent(`#tabs button:nth-child(${i + 1})`)), scheme); }
  await sp.close();
  const con = await sc.newPage(); await con.goto(B + '/console.html'); await con.waitForTimeout(1200);
  await con.fill('#newTitle', '（例）防水シート'); await con.fill('#newPrice', '9500'); await con.click('#addLot button[type=submit]'); await con.waitForTimeout(500);
  for (const id of ['#b_next', '#b_nv']) if (await con.isVisible(id) && await con.isEnabled(id)) { await con.click(id); await con.waitForTimeout(700); }
  await scan(con, 'console-open', scheme);
  await p.waitForTimeout(500); await scan(p, 'bidder-open-bidmode', scheme);
  await p.click('#bid'); await p.waitForTimeout(600); await scan(p, 'bidder-leading', scheme);
  const mon = await sc.newPage(); await mon.goto(B + '/monitor.html'); await mon.waitForTimeout(1200); await scan(mon, 'monitor', scheme);
  await con.click('#b_close'); await con.waitForTimeout(800); if (await con.isVisible('dialog[open]')) { await scan(con, 'console-dialog', scheme); await con.click('#dlgOk'); } await con.waitForTimeout(800);
  if (await con.isVisible('#b_close') && await con.isEnabled('#b_close')) { await con.click('#b_close'); await con.waitForTimeout(600); if (await con.isVisible('dialog[open]')) await con.click('#dlgOk'); }
  await p.waitForTimeout(700); await scan(p, 'bidder-won', scheme);
  await c.close(); await sc.close();
}
const by = {};
for (const v of out) { const k = `${v.id} [${v.impact}]`; (by[k] ??= { pages: new Set(), n: 0, ex: v.ex[0] }); by[k].pages.add(`${v.page}/${v.scheme}`); by[k].n += v.n; }
for (const [k, v] of Object.entries(by)) console.log(`NG ${k} 箇所=${v.n} 画面=${[...v.pages].join(', ')}\n   例: ${v.ex}`);
await br.close();
server.kill();
fs.rmSync(D, { recursive: true, force: true });
if (out.length) { console.error(`\nアクセシビリティの違反: ${out.length} 件`); process.exit(1); }
console.log('アクセシビリティ: 違反なし（明るい配色・暗い配色、全画面）');
