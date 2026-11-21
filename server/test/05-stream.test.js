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

test('競りがない状態が始まった時刻を進行コンソールに伝える（配信の止め忘れの注意に使う）', async () => {
  const lot = await createLot(A, 1000);
  A.send({ type: 'sync' });
  const idle = await A.waitFor((x) => x.type === 'snapshot');
  assert.equal(typeof idle.stream.idleSince, 'number'); // 競りがない
  assert.ok(idle.stream.idleWarnMs > 0);
  const busy = A.waitFor((x) => x.type === 'stream' && x.stream.idleSince === null);
  await A.cmd('start', { lotId: lot.id });
  await busy; // 競りが始まったら、数えるのをやめる
  await A.cmd('back_to_waiting', { lotId: lot.id });
  A.send({ type: 'sync' });
  const again = await A.waitFor((x) => x.type === 'snapshot');
  assert.ok(again.stream.idleSince >= idle.stream.idleSince);
});

test('カメラの切り替え: OBS の「カメラ」で始まるシーンを一覧にし、進行役が配信を止めずに切り替える（報告書 92 章）', async () => {
  // 前のテストで OBS を止めているので、別のサーバー・OBS・エージェントで確かめる
  const ctx3 = makeEnv(T);
  const srv3 = await startServer(ctx3);
  const obs3 = startMockObs({ port: 0, startDelayMs: 100, stopDelayMs: 100 });
  await new Promise((r) => obs3.wss.on('listening', r));
  const port3 = obs3.wss.address().port;
  const { auctioneer: A3 } = await connectAll(srv3, ctx3, 0);
  const is = (pred, ms = 5000) => A3.waitFor((x) => x.type === 'stream' && pred(x.stream), ms);
  const listedP = is((s) => s.cameras.length === 3);
  const agent3 = spawn('node', ['src/agent.js'], {
    cwd: path.join(ROOT, 'agent'), stdio: 'ignore',
    env: { ...process.env, AGENT_SERVER_URL: srv3.agentUrl, AGENT_TOKEN: ctx3.tokens.agent, OBS_URL: `ws://127.0.0.1:${port3}`, AGENT_LOG_DIR: path.join(ctx3.dataDir, 'agent-logs') },
  });
  try {
    const listed = await listedP;
    assert.deepEqual(listed.stream.cameras, ['カメラ: スマホ', 'カメラ: 無線', 'カメラ: USB'], 'OBS の画面と同じ並び。「カメラ」で始まらないシーンは出さない');
    assert.equal(listed.stream.camera, 'カメラ: スマホ');
    // 配信中に切り替えても、配信は止まらない
    const on = is((s) => s.obsActive === true);
    await A3.cmd('stream_start');
    await on;
    const switched = is((s) => s.camera === 'カメラ: USB');
    assert.equal((await A3.cmd('camera', { camera: 'カメラ: USB' })).ok, true);
    await switched;
    assert.equal(obs3.state.current, 'カメラ: USB');
    assert.equal(obs3.state.active, true, '切り替えても、配信は続く');
    const bad = await A3.cmd('camera', { camera: '休憩の画面' });
    assert.equal(bad.ok, false, '「カメラ」で始まらないシーンには、切り替えない');
    assert.match(bad.message, /OBS にありません/);
    assert.equal(obs3.state.current, 'カメラ: USB');
    // OBS の画面で、手で切り替えた場合も、進行コンソールに伝わる
    const manual = is((s) => s.camera === 'カメラ: スマホ');
    const c = new (await import('ws')).WebSocket(`ws://127.0.0.1:${port3}`);
    await new Promise((r) => c.on('open', r));
    c.send(JSON.stringify({ op: 6, d: { requestType: 'SetCurrentProgramScene', requestId: 'x', requestData: { sceneName: 'カメラ: スマホ' } } }));
    await manual;
    c.close();
    // OBS が止まったら、カメラの一覧を消す（切り替えられないため）
    const cleared = is((s) => s.cameras.length === 0);
    await obs3.close();
    await cleared;
  } finally { agent3.kill(); await obs3.close().catch(() => {}); await srv3.stop(); cleanup(ctx3); }
});

test('OBS の出力解像度を 960×720 にそろえる。配信中は止まってから。基本解像度の比が違えば変えずに知らせる（報告書 93 章）', async () => {
  const run = async (video, check) => {
    const ctx4 = makeEnv(T);
    const srv4 = await startServer(ctx4);
    const obs4 = startMockObs({ port: 0, startDelayMs: 100, stopDelayMs: 100, video });
    await new Promise((r) => obs4.wss.on('listening', r));
    const { auctioneer: A4 } = await connectAll(srv4, ctx4, 0);
    const is = (pred, ms = 5000) => A4.waitFor((x) => x.type === 'stream' && x.stream.video && pred(x.stream.video), ms);
    const agent4 = spawn('node', ['src/agent.js'], {
      cwd: path.join(ROOT, 'agent'), stdio: 'ignore',
      env: { ...process.env, AGENT_SERVER_URL: srv4.agentUrl, AGENT_TOKEN: ctx4.tokens.agent, OBS_URL: `ws://127.0.0.1:${obs4.wss.address().port}`, AGENT_LOG_DIR: path.join(ctx4.dataDir, 'agent-logs'), AGENT_VIDEO_POLL_MS: '200' },
    });
    try { await check({ A4, obs4, is }); } finally { agent4.kill(); await obs4.close(); await srv4.stop(); cleanup(ctx4); }
  };
  // 基本 1440×1080・出力 1440×1080 → 出力を 960×720 にする
  await run({}, async ({ obs4, is }) => {
    const v = await is((x) => x.output[0] === 960);
    assert.deepEqual([v.stream.video.output, v.stream.video.base, v.stream.video.state], [[960, 720], [1440, 1080], 'ok']);
    assert.deepEqual([obs4.state.video.outputWidth, obs4.state.video.outputHeight, obs4.state.video.baseWidth], [960, 720, 1440], '基本解像度は変えない');
  });
  // 配信中につながった → 止まるまで待って、止まったらそろえる
  await run({}, async ({ A4, obs4, is }) => {
    obs4.state.active = true;
    await is((x) => x.state === 'streaming');
    assert.equal(obs4.state.video.outputWidth, 1440, '配信中は変えない');
    const done = is((x) => x.output[0] === 960);
    await A4.cmd('stream_stop');
    await done;
  });
  // 基本解像度が 16:9 → 変えずに知らせる
  await run({ baseWidth: 1920, baseHeight: 1080, outputWidth: 1280, outputHeight: 720 }, async ({ obs4, is }) => {
    const v = await is((x) => x.state === 'base_aspect');
    assert.deepEqual(v.stream.video.output, [1280, 720]);
    assert.equal(obs4.state.video.outputWidth, 1280, 'ゆがむので、変えない');
  });
  // つないだあとで、OBS の画面で映像の設定が手で変えられた（OBS は、そのことを知らせない）→ 読みにいって気づく
  await run({}, async ({ obs4, is }) => {
    await is((x) => x.output[0] === 960 && x.state === 'ok');
    Object.assign(obs4.state.video, { baseWidth: 1920, baseHeight: 1080, outputWidth: 1096, outputHeight: 616 });
    const v = await is((x) => x.state === 'base_aspect');
    assert.deepEqual([v.stream.video.base, v.stream.video.output], [[1920, 1080], [1096, 616]]);
    assert.equal(obs4.state.video.outputWidth, 1096, 'ゆがむので、変えない');
    // 基本解像度を 4:3 に戻すと、出力をそろえ直す
    Object.assign(obs4.state.video, { baseWidth: 1440, baseHeight: 1080 });
    const v2 = await is((x) => x.state === 'ok' && x.output[0] === 960);
    assert.deepEqual(v2.stream.video.output, [960, 720]);
    assert.deepEqual([obs4.state.video.outputWidth, obs4.state.video.outputHeight], [960, 720]);
  });
});

test('配信エージェントの合言葉を、設定（POC_AGENT_TOKEN）から登録する。ほかの合言葉は使えなくなる（報告書 94 章）', async () => {
  const { WebSocket } = await import('ws');
  const tryAgent = (url, token) => new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_, res) => resolve(res.statusCode));
    ws.on('error', () => resolve('error'));
  });
  const token = 'x'.repeat(16) + Math.random().toString(36).slice(2) + 'y'.repeat(16);
  const ctx5 = makeEnv({ ...T, POC_AGENT_TOKEN: token });
  const srv5 = await startServer(ctx5);
  try {
    assert.equal(await tryAgent(srv5.agentUrl, token), 'open', '設定の合言葉で、つながる');
    assert.equal(await tryAgent(srv5.agentUrl, ctx5.tokens.agent), 401, '開発用の合言葉は、使えなくなる');
    assert.equal(await tryAgent(srv5.agentUrl, 'wrong'), 401);
  } finally { await srv5.stop(); }
  // 合言葉を変えて起動し直すと、前の合言葉は使えない。短すぎる値は登録しない
  const token2 = token.replace(/x/g, 'z');
  ctx5.env.POC_AGENT_TOKEN = token2;
  const srv6 = await startServer(ctx5);
  try {
    assert.equal(await tryAgent(srv6.agentUrl, token2), 'open');
    assert.equal(await tryAgent(srv6.agentUrl, token), 401, '前の合言葉は、使えなくなる');
  } finally { await srv6.stop(); }
  ctx5.env.POC_AGENT_TOKEN = 'short';
  const srv7 = await startServer(ctx5);
  try {
    assert.equal(await tryAgent(srv7.agentUrl, 'short'), 401, '32文字に満たない合言葉は、登録しない');
    assert.equal(await tryAgent(srv7.agentUrl, token2), 'open', 'その場合は、前の登録のまま');
  } finally { await srv7.stop(); cleanup(ctx5); }
});
