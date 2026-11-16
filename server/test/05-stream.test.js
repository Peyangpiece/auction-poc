// 配信の自動制御の「仕組み」のテスト（8.6、FR-STR-003、POC-AGT-004）。
// 本物の配信エージェントを別プロセスで動かし、OBS と IVS は代役（モック）を使う。待ち時間は短くしてある。
// P1 の合否そのもの（本物の OBS・IVS での秒数）は、ここでは判定できない。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { makeEnv, startServer, connectAll, createLot, cleanup, sleep, ROOT } from './helpers.js';
import { startMockObs } from '../../tools/mock-obs.js';

let ctx, srv, A, m, obs, agent, obsPort;
const T = { POC_IVS_MODE: 'mock', POC_IVS_MOCK_DELAY_MS: '200', POC_LIVE_SETTLE_MS: '300', POC_LIVE_TIMEOUT_MS: '1500', POC_AUTO_STOP_MS: '1000' };

function startAgent() {
  const child = spawn('node', ['src/agent.js'], {
    cwd: path.join(ROOT, 'agent'), stdio: 'ignore',
    env: { ...process.env, AGENT_SERVER_URL: srv.agentUrl, AGENT_TOKEN: ctx.tokens.agent, OBS_URL: `ws://127.0.0.1:${obsPort}`, AGENT_LOG_DIR: path.join(ctx.dataDir, 'agent-logs'), AGENT_OUTPUT_WAIT_MS: '3000' },
  });
  child.exited = new Promise((r) => child.on('exit', r));
  return child;
}
const streamIs = (pred, ms = 5000) => A.waitFor((x) => x.type === 'stream' && pred(x.stream), ms);
const lotIs = (id, status, ms = 5000) => A.waitFor((x) => x.type === 'lot' && x.lot.id === id && x.lot.status === status, ms);

before(async () => {
  ctx = makeEnv(T);
  srv = await startServer(ctx);
  ({ auctioneer: A, members: m } = await connectAll(srv, ctx, 2));
  obs = startMockObs({ port: 0, startDelayMs: 200, stopDelayMs: 100 });
  await new Promise((r) => obs.wss.on('listening', r));
  obsPort = obs.wss.address().port;
  const connected = streamIs((s) => s.agentConnected);
  agent = startAgent();
  await connected;
});
after(async () => { agent.kill(); await obs.close(); await srv.stop(); cleanup(ctx); });

test('競り開始 → 配信準備中 → OBS 配信開始 → LIVE → 待ち時間 → 受付中。落札後、無操作が続くと自動で停止', async () => {
  const lot = await createLot(A, 1000);
  const opened = lotIs(lot.id, 'open');
  const t0 = Date.now();
  assert.equal((await A.cmd('start', { lotId: lot.id })).ok, true);
  assert.equal(A.lots.get(lot.id).status, 'preparing');
  assert.equal((await m[0].bid(lot.id, 1000)).code, 'LOT_NOT_OPEN'); // 映像が届くまでは受け付けない
  await opened;
  assert.ok(Date.now() - t0 >= 300 + 200, 'LIVE になってから待ち時間をおいて受付中になる');
  assert.equal(obs.state.active, true);
  assert.equal((await m[0].bid(lot.id, 1000)).accepted, true);

  const stopped = streamIs((s) => !s.live && s.obsActive === false);
  const t1 = Date.now();
  await A.cmd('close', { lotId: lot.id });
  await stopped;
  const waited = Date.now() - t1;
  assert.ok(waited >= 1000 && waited < 2500, `自動停止は設定した待ち時間の後（${waited}ms）`);
  assert.equal(obs.state.active, false);
});

test('配信中に次の競りを始めると、すぐ受付中になり、自動停止は取り消される', async () => {
  const a = await createLot(A, 1000);
  const b = await createLot(A, 1000);
  const opened = lotIs(a.id, 'open');
  await A.cmd('start', { lotId: a.id });
  await opened;
  await A.cmd('close', { lotId: a.id });
  await sleep(500); // 自動停止（1秒）の前に次を始める
  assert.equal((await A.cmd('start', { lotId: b.id })).ok, true);
  assert.equal(A.lots.get(b.id).status, 'open'); // 配信中なので、配信準備中を通らない
  await sleep(1200);
  assert.equal(obs.state.active, true, '受付中のロットがある間は止めない');

  // 中断のまま待ち時間が過ぎたら止める。再開は「競り開始」と同じ手順で映像を待つ（FR-STR-003）
  const stopped = streamIs((s) => !s.live && s.obsActive === false);
  await A.cmd('suspend', { lotId: b.id });
  await stopped;
  const reopened = lotIs(b.id, 'open');
  assert.equal((await A.cmd('resume', { lotId: b.id })).ok, true);
  assert.equal(A.lots.get(b.id).status, 'preparing');
  // 再開の途中で「待機に戻す」を選んだら、入札を持ったまま中断に戻る（待機にはしない）
  assert.equal((await A.cmd('back_to_waiting', { lotId: b.id })).ok, true);
  assert.equal(A.lots.get(b.id).status, 'suspended');
  await A.cmd('resume', { lotId: b.id });
  await reopened;
  await A.cmd('close', { lotId: b.id });
  await streamIs((s) => !s.live && s.obsActive === false);
});

test('P1-3 相当: 配信中にエージェントが切れても配信は止まらず、再接続後に状態が一致する', async () => {
  const lot = await createLot(A, 1000);
  const opened = lotIs(lot.id, 'open');
  await A.cmd('start', { lotId: lot.id });
  await opened;

  const gone = streamIs((s) => !s.agentConnected);
  agent.kill('SIGKILL');
  await gone;
  await sleep(300);
  assert.equal(obs.state.active, true, '切れている間、OBS の配信は変わらない');

  // 切れている間に落札し、自動停止の時刻が来る（指示は届かない）
  await A.cmd('close', { lotId: lot.id });
  await sleep(1300);
  assert.equal(obs.state.active, true);

  // 再接続したら、サーバーが望む状態（停止）に合わせる
  const reconciled = streamIs((s) => s.agentConnected && s.obsActive === false && !s.live);
  agent = startAgent();
  await reconciled;
  assert.equal(obs.state.active, false);
});

test('P1-4 相当: OBS が終了していると、待ち時間の後に配信準備中（警告）になり、2つの選択肢を選べる', async () => {
  await obs.close();
  const lot = await createLot(A, 1000);
  const warned = lotIs(lot.id, 'preparing_warn');
  const t0 = Date.now();
  await A.cmd('start', { lotId: lot.id });
  await warned;
  assert.ok(Date.now() - t0 >= 1500);
  assert.equal((await A.cmd('back_to_waiting', { lotId: lot.id })).ok, true);
  assert.equal(A.lots.get(lot.id).status, 'waiting');

  const warned2 = lotIs(lot.id, 'preparing_warn');
  await A.cmd('start', { lotId: lot.id });
  await warned2;
  assert.equal((await A.cmd('start_without_video', { lotId: lot.id })).ok, true);
  assert.deepEqual([A.lots.get(lot.id).status, A.lots.get(lot.id).noVideo], ['open', true]);
  assert.equal((await m[0].bid(lot.id, 1000)).accepted, true);
  assert.equal((await A.cmd('close', { lotId: lot.id })).status, 'sold');
});

test('配信準備中にサーバーが落ちたら、再起動後は待機に戻る（8.6）', async () => {
  const lot = await createLot(A, 1000);
  await A.cmd('start', { lotId: lot.id });
  assert.equal(A.lots.get(lot.id).status, 'preparing');
  await srv.kill9();
  srv = await startServer(ctx);
  ({ auctioneer: A, members: m } = await connectAll(srv, ctx, 2));
  assert.equal(A.lots.get(lot.id).status, 'waiting');
});

test('既定では自動停止しない: 落札の後も配信は続き、止まるのは進行役が停止を押したときだけ', async () => {
  // 既定の設定（POC_AUTO_STOP_MS を指定しない）のサーバーを、別に立てて確かめる
  const ctx2 = makeEnv({ POC_IVS_MODE: 'mock', POC_IVS_MOCK_DELAY_MS: '200', POC_LIVE_SETTLE_MS: '300' });
  delete ctx2.env.POC_AUTO_STOP_MS;
  const srv2 = await startServer(ctx2);
  const obs2 = startMockObs({ port: 0, startDelayMs: 100, stopDelayMs: 100 });
  await new Promise((r) => obs2.wss.on('listening', r));
  const { auctioneer: A2 } = await connectAll(srv2, ctx2, 0);
  const connected = A2.waitFor((x) => x.type === 'stream' && x.stream.agentConnected);
  const agent2 = spawn('node', ['src/agent.js'], {
    cwd: path.join(ROOT, 'agent'), stdio: 'ignore',
    env: { ...process.env, AGENT_SERVER_URL: srv2.agentUrl, AGENT_TOKEN: ctx2.tokens.agent, OBS_URL: `ws://127.0.0.1:${obs2.wss.address().port}`, AGENT_LOG_DIR: path.join(ctx2.dataDir, 'agent-logs') },
  });
  await connected;
  const lot = await createLot(A2, 1000);
  const opened = A2.waitFor((x) => x.type === 'lot' && x.lot.id === lot.id && x.lot.status === 'open');
  await A2.cmd('start', { lotId: lot.id });
  await opened;
  await A2.cmd('close', { lotId: lot.id });
  await sleep(2500); // 以前の試験用の設定（1秒）なら、とうに止まっている長さ
  assert.equal(obs2.state.active, true, '競りがなくても配信は続く');
  const stopped = A2.waitFor((x) => x.type === 'stream' && x.stream.obsActive === false);
  assert.equal((await A2.cmd('stream_stop')).ok, true);
  await stopped;
  assert.equal(obs2.state.active, false);
  agent2.kill(); await obs2.close(); await srv2.stop(); cleanup(ctx2);
});
