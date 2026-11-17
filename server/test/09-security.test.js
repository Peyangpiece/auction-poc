// 守り: 読み込みの制限、よそのサイトからの接続、連打、接続数、名乗らない接続、バックアップ
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { makeEnv, startServer, connectAll, connect, createLot, lotLog, cleanup, sleep, ROOT } from './helpers.js';

const closed = (ws) => new Promise((resolve) => ws.on('close', (code) => resolve(code)));
const failed = (ws) => new Promise((resolve) => { ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)); ws.on('error', () => {}); });

test('画面を配るときに、ブラウザに守らせる制限を付ける。画面の中に直接書いたスクリプトとスタイルはない', async () => {
  const ctx = makeEnv();
  const srv = await startServer(ctx);
  for (const page of ['bidder.html', 'console.html']) {
    const res = await fetch(`${srv.httpUrl}/${page}`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp) && !/style-src[^;]*'unsafe-inline'/.test(csp), '直接書いたスクリプト・スタイルを許していない');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    const html = await res.text();
    assert.ok(!/<script>(?!\s*<\/script>)/.test(html) && !/<style[\s>]/.test(html) && !/\sstyle="/.test(html) && !/\son[a-z]+="/.test(html), `${page} に直接書いたスクリプト・スタイルがない`);
  }
  // 画面に使う種類のファイルしか配らない。フォルダの外には出られない
  assert.equal((await fetch(`${srv.httpUrl}/../package.json`)).status, 404);
  assert.equal((await fetch(`${srv.httpUrl}/%2e%2e%2fserver%2fsrc%2findex.js`)).status, 404);
  const health = await (await fetch(`${srv.httpUrl}/healthz`)).json();
  assert.deepEqual([health.ok, health.db], [true, true]);
  await srv.stop(); cleanup(ctx);
});

test('よそのサイトのページからの接続は断り、自分のサイトからの接続は受ける', async () => {
  const ctx = makeEnv();
  const srv = await startServer(ctx);
  const evil = new WebSocket(srv.url, { origin: 'https://evil.example' });
  assert.equal(await failed(evil), 403);
  const own = new WebSocket(srv.url, { origin: srv.httpUrl });
  await new Promise((r, j) => { own.on('open', r); own.on('error', j); });
  own.close();
  await srv.stop(); cleanup(ctx);
});

test('入札の速さに上限がある（会員ごと）。超えた分は RATE_LIMITED で返し、順番や記録には入れない', async () => {
  const ctx = makeEnv({ POC_BID_RATE: '5' });
  const srv = await startServer(ctx);
  const { auctioneer: A, members: m } = await connectAll(srv, ctx, 2);
  const lot = await createLot(A, 1000, 1000);
  await A.cmd('start', { lotId: lot.id });
  // 1人が一度に 30 件を送る（人の操作ではありえない速さ）
  const results = await Promise.all(Array.from({ length: 30 }, () => m[0].bid(lot.id, 1000)));
  const limited = results.filter((r) => r.code === 'RATE_LIMITED').length;
  assert.ok(limited >= 20, `大半が上限で止まる（${limited} 件）`);
  assert.equal(results.filter((r) => r.accepted).length, 1);
  const log = await lotLog(A, lot.id);
  assert.equal(log.bids.length, 30 - limited, '上限で止めた入札は、記録に入らない');
  // ほかの会員は影響を受けない
  assert.equal((await m[1].bid(lot.id, 2000)).accepted, true);
  // 時間がたてば、また入札できる
  await sleep(400);
  assert.equal((await m[0].bid(lot.id, 3000)).accepted, true);
  await srv.stop(); cleanup(ctx);
});

test('受信が速すぎる接続、名乗らない接続、同じ人の開きすぎた接続を切る', async () => {
  const ctx = makeEnv({ POC_MESSAGE_RATE: '20', POC_HELLO_TIMEOUT_MS: '300', POC_MAX_CONNECTIONS_PER_USER: '2' });
  const srv = await startServer(ctx);
  // 連打
  const flood = new WebSocket(srv.url);
  await new Promise((r) => flood.on('open', r));
  const floodClosed = closed(flood);
  for (let i = 0; i < 200; i++) flood.send(JSON.stringify({ type: 'time', t0: i }));
  assert.equal(await floodClosed, 4429);
  // 名乗らない
  const silent = new WebSocket(srv.url);
  assert.equal(await closed(silent), 4408);
  // 同じ会員の3つ目
  const token = ctx.tokens.members[0].token;
  const a = await connect(srv, token);
  const b = await connect(srv, token);
  const third = new WebSocket(srv.url);
  await new Promise((r) => third.on('open', r));
  const thirdClosed = closed(third);
  third.send(JSON.stringify({ type: 'hello', token }));
  assert.equal(await thirdClosed, 4409);
  // 1つ閉じれば、また開ける
  a.close();
  await sleep(100);
  const c = await connect(srv, token);
  assert.equal(c.paddle, b.paddle);
  await srv.stop(); cleanup(ctx);
});

test('同時接続の上限を超えた接続は断る', async () => {
  const ctx = makeEnv({ POC_MAX_CONNECTIONS: '3' });
  const srv = await startServer(ctx);
  const open = [];
  for (let i = 0; i < 3; i++) open.push(await connect(srv, ctx.tokens.members[i].token));
  const extra = new WebSocket(srv.url);
  assert.equal(await failed(extra), 503);
  open[0].close();
  await sleep(100);
  await connect(srv, ctx.tokens.members[3].token);
  await srv.stop(); cleanup(ctx);
});

test('バックアップ: 動かしたまま取れ、世代を残し、復元できる', async () => {
  const ctx = makeEnv();
  let srv = await startServer(ctx);
  let { auctioneer: A, members: m } = await connectAll(srv, ctx, 1);
  const lot = await createLot(A, 1000, 1000);
  await A.cmd('start', { lotId: lot.id });
  assert.equal((await m[0].bid(lot.id, 1000)).accepted, true);
  const run = (...args) => execFileSync('node', ['tools/backup.js', ...args], { cwd: ROOT, env: ctx.env, encoding: 'utf8' });
  const dir = path.join(ctx.dataDir, 'backups');
  assert.match(run('--keep', '2'), /バックアップを取りました.*入札 1 件/); // サーバーは動いたまま
  // 3回取ると、2世代だけ残る（名前が秒単位なので、少し待つ）
  await sleep(1100); run('--keep', '2');
  await sleep(1100); run('--keep', '2');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
  assert.equal(files.length, 2);
  assert.equal(fs.readdirSync(dir).some((f) => f.endsWith('.partial')), false);
  // バックアップの後に入った入札は、復元すると無くなる（バックアップの時点に戻る）
  const firstBackup = path.join(dir, files[0]);
  const other = (await connectAll(srv, ctx, 2)).members[1];
  assert.equal((await other.bid(lot.id, 2000)).accepted, true);
  await srv.stop();
  assert.match(run('--restore', firstBackup), /復元しました/);
  assert.ok(fs.readdirSync(ctx.dataDir).some((f) => f.includes('before-restore')), '元のデータベースは消さずに残す');
  srv = await startServer(ctx);
  ({ auctioneer: A } = await connectAll(srv, ctx, 0));
  const log = await lotLog(A, lot.id);
  assert.deepEqual(log.bids.map((x) => x.amount), [1000]);
  await srv.stop(); cleanup(ctx);
});

test('見つからないページは、案内のページを 404 で返す。部品は短い返事だけ', async () => {
  const ctx = makeEnv();
  const srv = await startServer(ctx);
  try {
    const page = await fetch(`${srv.httpUrl}/nai-page.html`);
    assert.equal(page.status, 404);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /ページが見つかりません/);
    const part = await fetch(`${srv.httpUrl}/nai.js`);
    assert.equal(part.status, 404);
    assert.equal(await part.text(), 'not found');
  } finally { await srv.stop(); cleanup(ctx); }
});

test('画面の部品は、中身が同じなら送り直さない（ETag と 304）', async () => {
  const ctx = makeEnv();
  const srv = await startServer(ctx);
  try {
    const first = await fetch(`${srv.httpUrl}/app.css`);
    const etag = first.headers.get('etag');
    assert.equal(first.status, 200);
    assert.ok(etag && first.headers.get('cache-control') === 'no-cache');
    const again = await fetch(`${srv.httpUrl}/app.css`, { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
    assert.equal((await again.text()).length, 0);
    assert.equal((await fetch(`${srv.httpUrl}/app.css`, { headers: { 'if-none-match': '"old"' } })).status, 200);
  } finally { await srv.stop(); cleanup(ctx); }
});

test('ログインしていない人がトップページを開くと、ログインの画面へ送る', async () => {
  const ctx = makeEnv();
  const srv = await startServer(ctx);
  try {
    for (const p of ['/', '/index.html']) {
      const res = await fetch(`${srv.httpUrl}${p}`, { redirect: 'manual' });
      assert.deepEqual([res.status, res.headers.get('location')], [302, '/login.html']);
    }
    assert.equal((await fetch(`${srv.httpUrl}/login.html`)).status, 200);
    assert.equal((await fetch(`${srv.httpUrl}/legal.html`)).status, 200, '規約は、ログインなしで読める');
  } finally { await srv.stop(); cleanup(ctx); }
});
