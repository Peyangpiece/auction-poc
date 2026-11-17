// 運用のための仕組み: 測定の記録の上限、生存確認
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { Metrics } from '../src/metrics.js';
import { makeEnv, startServer, connectAll, cleanup, sleep } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-'));
const sizeOf = (dir) => fs.readdirSync(dir).reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);

test('測定の記録は、ファイルを切り替えながら、全体の上限を超えた古い分を消す', async () => {
  const dir = tmp();
  const m = new Metrics(dir, { level: 'full', fileMb: 0.02, maxMb: 0.08 }); // 20KB ごとに切り替え、全体で 80KB まで
  for (let i = 0; i < 4000; i++) m.write('bid', { seq: i, pad: 'x'.repeat(60) }); // 合計で約 400KB を書く
  await m.close();
  await sleep(200); // 書き出しが終わって、古いファイルが消えるのを待つ
  const files = fs.readdirSync(dir);
  assert.ok(files.length >= 2, 'ファイルが切り替わっている');
  assert.ok(sizeOf(dir) <= 0.08 * 1048576 + 0.02 * 1048576 * 2, `全体が上限の近くに収まっている（${sizeOf(dir)} bytes）`);
  // いちばん新しい記録は残っている
  const all = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  assert.ok(all.includes('"seq":3999'));
  assert.ok(!all.includes('"seq":0,'), '古い記録は消えている');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('basic では端末ごとの送り返しを記録せず、off では何も書かない', async () => {
  const dir = tmp();
  const m = new Metrics(dir, { level: 'basic' });
  m.write('bid', { seq: 1 }); m.write('price_ack', { seq: 1 }); m.write('result_ack', {}); m.write('video_latency', {});
  await m.close();
  const text = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  assert.ok(text.includes('"type":"bid"'));
  assert.ok(!text.includes('price_ack') && !text.includes('result_ack') && !text.includes('video_latency'));
  const dir2 = path.join(tmp(), 'never-created');
  const off = new Metrics(dir2, { level: 'off' });
  off.write('bid', { seq: 1 });
  await off.close();
  assert.equal(fs.existsSync(dir2), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('生存確認: 応答しなくなった端末の接続を、サーバーが切る', async () => {
  const ctx = makeEnv({ POC_HEARTBEAT_MS: '200' });
  const srv = await startServer(ctx);
  const { auctioneer: A } = await connectAll(srv, ctx, 0);
  // 応答（pong）を返さない端末を作る: 受信を止めて、回線が黙って切れたのと同じ状態にする
  const dead = new WebSocket(srv.url, { perMessageDeflate: false, autoPong: false });
  await new Promise((r) => dead.on('open', r));
  const joined = A.waitFor((x) => x.type === 'presence' && x.members === 1);
  dead.send(JSON.stringify({ type: 'hello', token: ctx.tokens.members[0].token }));
  await joined;
  const gone = A.waitFor((x) => x.type === 'presence' && x.members === 0, 5000);
  await gone; // 応答がないので、サーバーが切って、参加者の数が減る
  // 応答している進行役の接続は切られない
  await sleep(700);
  assert.equal((await A.cmd('mark', { label: 'still-alive' })).ok, true);
  dead.terminate();
  await srv.stop(); cleanup(ctx);
});
