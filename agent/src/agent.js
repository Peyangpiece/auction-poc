#!/usr/bin/env node
// 配信エージェント（POC-AGT-001〜005、本仕様 IF-EXT-001）
//
// 配信用PCで常駐する。入札サーバーへ「外向き」に WebSocket で接続し、届いた指示を obs-websocket で OBS に伝える。
// ・このプログラムは待ち受けポートを開かない（配信用PCに、外から入ってくる接続を受けさせない）。
// ・obs-websocket のパスワードは、このPCの環境変数（または agent/.env）だけに置く。サーバーには送らない。
// ・IVS のストリームキーは OBS の設定の中だけにある。このプログラムは読みも送りもしない。
// ・サーバーとの接続が切れている間は、OBS の配信の状態を変えない（POC-AGT-004）。
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import OBSWebSocket from 'obs-websocket-js/json';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(here, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const cfg = {
  serverUrl: process.env.AGENT_SERVER_URL, // 例: wss://poc.example.jp/agent
  token: process.env.AGENT_TOKEN,
  obsUrl: process.env.OBS_URL || 'ws://127.0.0.1:4455', // 既定のポート 4455 は【未検証】。実機で確かめる
  obsPassword: process.env.OBS_PASSWORD || undefined,
  outputWaitMs: Number(process.env.AGENT_OUTPUT_WAIT_MS || 10000),
  logDir: process.env.AGENT_LOG_DIR || path.join(here, 'logs'),
  // カメラの切り替え（報告書 92 章）: OBS のシーンのうち、名前がこの言葉で始まるものを「カメラ」として進行コンソールに出す
  cameraPrefix: process.env.AGENT_CAMERA_PREFIX || 'カメラ',
  // OBS の出力解像度（報告書 93 章）。IVS の視聴の料金を HD の区分に収めるため、既定は 960×720（4:3）。off で触らない
  outputSize: (process.env.AGENT_OUTPUT_SIZE || '960x720').toLowerCase(),
  // OBS の映像の設定を読みにいく間隔。obs-websocket 5.x には、映像の設定が変わったことを知らせる仕組みがないため
  videoPollMs: Number(process.env.AGENT_VIDEO_POLL_MS || 3000),
};
const wantSize = (() => { const m = /^(\d{3,4})x(\d{3,4})$/.exec(cfg.outputSize); return m ? { w: Number(m[1]), h: Number(m[2]) } : null; })();
if (!cfg.serverUrl || !cfg.token) {
  console.error('AGENT_SERVER_URL と AGENT_TOKEN を環境変数（または agent/.env）で指定してください。');
  process.exit(1);
}

const localNow = () => performance.timeOrigin + performance.now();
let offset = 0; // サーバーの時刻 − このPCの時刻
const now = () => Math.round((localNow() + offset) * 1000) / 1000;

fs.mkdirSync(cfg.logDir, { recursive: true });
const logFile = path.join(cfg.logDir, `agent-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
function log(type, data = {}) {
  const rec = { type, at: now(), localAt: localNow(), ...data };
  logStream.write(JSON.stringify(rec) + '\n');
  console.log(`[agent] ${type}`, JSON.stringify(data));
}

// ------------------------------------------------------------------ OBS
const obs = new OBSWebSocket();
let obsConnected = false;
let obsVersion = null;

async function connectObs() {
  if (obsConnected) return true;
  try {
    const hello = await obs.connect(cfg.obsUrl, cfg.obsPassword);
    obsConnected = true;
    const v = await obs.call('GetVersion');
    obsVersion = { obs: v.obsVersion, obsWebSocket: v.obsWebSocketVersion, rpc: hello.negotiatedRpcVersion, platform: v.platform };
    log('obs_connected', obsVersion); // 【未検証】の確認用: OBS と obs-websocket のバージョンを記録する
    reportCameras();
    ensureOutputSize();
    return true;
  } catch (err) {
    log('obs_connect_failed', { message: err.message, code: err.code });
    return false;
  }
}
obs.on('ConnectionClosed', (err) => {
  if (obsConnected) log('obs_disconnected', { message: err?.message });
  obsConnected = false;
  sendToServer({ type: 'agent_state', obsActive: false, obsConnected: false, at: now() });
  sendToServer({ type: 'agent_cameras', cameras: [], current: null, at: now() }); // OBS が止まっている間は、切り替えられない
});
// OBS の側で配信の状態が変わったら（手で止められた場合も含めて）、サーバーに知らせる
obs.on('StreamStateChanged', (e) => {
  log('obs_stream_state', { outputActive: e.outputActive, outputState: e.outputState });
  if (e.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED' || e.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
    sendToServer({ type: 'agent_state', obsActive: e.outputActive, obsConnected: true, at: now() });
  }
  if (e.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') ensureOutputSize(); // 配信中にそろえられなかった分を、止まったときにそろえる
});
setInterval(() => { if (!obsConnected) connectObs(); }, 5000).unref();

// ------------------------------------------------------------------ 出力解像度（報告書 93 章）
// OBS につないだとき（と、配信が止まったとき、OBS の画面で映像の設定が変えられたとき）に、出力解像度を決めた大きさにそろえる。
// ・配信中は変えない（OBS は、出力が動いている間は映像の設定を変えられない）。止まったときにそろえる
// ・基本（キャンバス）解像度の縦横の比が違えば、変えない（映像がゆがむため）。進行コンソールに注意を出す
let lastVideoKey = null; // 最後に確かめた映像の設定（基本・出力の解像度）
const videoKey = (v) => `${v.baseWidth}x${v.baseHeight}/${v.outputWidth}x${v.outputHeight}`;
async function ensureOutputSize() {
  if (!obsConnected) return;
  try {
    let v = await obs.call('GetVideoSettings');
    let state = 'ok';
    if (wantSize && (v.outputWidth !== wantSize.w || v.outputHeight !== wantSize.h)) {
      if (v.baseWidth * wantSize.h !== v.baseHeight * wantSize.w) state = 'base_aspect';
      else if ((await obs.call('GetStreamStatus')).outputActive) state = 'streaming';
      else {
        await obs.call('SetVideoSettings', { outputWidth: wantSize.w, outputHeight: wantSize.h });
        log('obs_output_size', { from: [v.outputWidth, v.outputHeight], to: [wantSize.w, wantSize.h] });
        v = await obs.call('GetVideoSettings');
      }
    }
    lastVideoKey = videoKey(v);
    sendToServer({ type: 'agent_video', base: [v.baseWidth, v.baseHeight], output: [v.outputWidth, v.outputHeight], want: wantSize ? [wantSize.w, wantSize.h] : null, state, at: now() });
  } catch (err) { log('obs_output_size_failed', { message: err.message }); }
}
// obs-websocket 5.x には、映像の設定が変わったことを知らせる仕組み（イベント）がない。
// そのため、OBS の「設定 → 映像」が手で変えられても気づけるよう、決まった間隔で読みにいき、変わっていたら確かめ直す
let videoPolling = false;
setInterval(async () => {
  if (!obsConnected || videoPolling || lastVideoKey === null) return;
  videoPolling = true;
  try {
    const v = await obs.call('GetVideoSettings');
    if (videoKey(v) !== lastVideoKey) {
      log('obs_video_changed', { from: lastVideoKey, to: videoKey(v) });
      await ensureOutputSize();
    }
  } catch { /* つながっていない間は、次の回に任せる */ }
  finally { videoPolling = false; }
}, cfg.videoPollMs).unref();

// ------------------------------------------------------------------ カメラ（OBS のシーン。報告書 92 章）
// スマホ・無線カメラ・USB カメラは、OBS の中で、それぞれのシーンに入れておく。ここは、どのシーンを映すかを切り替えるだけ
async function cameraState() {
  const list = await obs.call('GetSceneList');
  const names = list.scenes.map((x) => x.sceneName).filter((n) => n.startsWith(cfg.cameraPrefix));
  // OBS は、シーンの一覧を下から上の順で返す（OBS の画面の上にあるものが、配列の後ろ）。画面の並びにそろえる
  names.reverse();
  return { cameras: names, current: list.currentProgramSceneName ?? null };
}
async function reportCameras() {
  if (!obsConnected) return;
  try { sendToServer({ type: 'agent_cameras', ...(await cameraState()), at: now() }); }
  catch (err) { log('camera_list_failed', { message: err.message }); }
}
for (const ev of ['CurrentProgramSceneChanged', 'SceneListChanged', 'SceneNameChanged', 'SceneCreated', 'SceneRemoved']) obs.on(ev, () => reportCameras());

/** 配信の状態が want になるまで待つ（StartStream / StopStream は、受け付けた時点で返ってくるため） */
async function waitOutput(want) {
  const deadline = localNow() + cfg.outputWaitMs;
  while (localNow() < deadline) {
    const st = await obs.call('GetStreamStatus');
    if (st.outputActive === want && !st.outputReconnecting) return st;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function handle(cmd) {
  const timings = { receivedAt: now(), obsSentAt: null, obsResultAt: null, obsStateAt: null };
  const done = (ok, extra = {}) => {
    const res = { type: 'agent_result', id: cmd.id, ok, timings, obsVersion, ...extra };
    log('cmd', { id: cmd.id, action: cmd.action, serverSentAt: cmd.sentAt, ok, ...timings, ...extra });
    sendToServer(res);
  };
  try {
    if (!(await connectObs())) return done(false, { error: 'obs_not_connected', obsActive: false });
    const before = await obs.call('GetStreamStatus');
    if (cmd.action === 'status') {
      timings.obsSentAt = timings.receivedAt;
      timings.obsResultAt = now();
      return done(true, { obsActive: before.outputActive });
    }
    if (cmd.action === 'camera') {
      // 映すカメラを切り替える。配信は止めない（シーンを替えるだけ）
      const { cameras } = await cameraState();
      if (!cameras.includes(cmd.camera)) return done(false, { error: 'unknown_camera', obsActive: before.outputActive });
      timings.obsSentAt = now();
      await obs.call('SetCurrentProgramScene', { sceneName: cmd.camera });
      timings.obsResultAt = timings.obsStateAt = now();
      reportCameras();
      return done(true, { obsActive: before.outputActive, camera: cmd.camera });
    }
    const want = cmd.action === 'start';
    if (cmd.action !== 'start' && cmd.action !== 'stop') return done(false, { error: 'unknown_action' });
    if (before.outputActive === want) {
      timings.obsSentAt = timings.obsResultAt = timings.obsStateAt = now();
      return done(true, { obsActive: want, already: true });
    }
    timings.obsSentAt = now();
    await obs.call(want ? 'StartStream' : 'StopStream');
    timings.obsResultAt = now();
    const st = await waitOutput(want);
    timings.obsStateAt = now();
    if (!st) return done(false, { error: 'obs_output_timeout', obsActive: !want });
    return done(true, { obsActive: want });
  } catch (err) {
    return done(false, { error: err.message, code: err.code ?? null, obsActive: null });
  }
}

// ------------------------------------------------------------------ 入札サーバーとの接続（外向きだけ）
let ws = null;
let attempts = 0;
const timeWaiters = new Map();

function sendToServer(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

async function syncClock() {
  let best = null;
  for (let i = 0; i < 5; i++) {
    const t0 = localNow();
    const ts = await new Promise((resolve) => {
      timeWaiters.set(t0, resolve);
      sendToServer({ type: 'time', t0 });
      setTimeout(() => resolve(null), 3000);
    });
    if (ts === null) continue;
    const rtt = localNow() - t0;
    if (!best || rtt < best.rtt) best = { rtt, offset: ts - (t0 + rtt / 2) };
  }
  if (best) {
    offset = best.offset;
    log('clock_sync', best);
  }
}

function connectServer() {
  ws = new WebSocket(cfg.serverUrl, { headers: { authorization: `Bearer ${cfg.token}` }, perMessageDeflate: false });
  ws.on('open', () => {
    attempts = 0;
    log('server_connected');
    syncClock();
    reportCameras();
    ensureOutputSize();
  });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'time') return timeWaiters.get(msg.t0)?.(msg.ts), timeWaiters.delete(msg.t0);
    if (msg.type === 'agent_cmd') handle(msg);
  });
  ws.on('close', (code) => {
    log('server_disconnected', { code });
    // 切れている間は OBS に何もしない。1秒後に1回目、その後は2秒ごとに接続し直す
    setTimeout(connectServer, attempts++ === 0 ? 1000 : 2000);
  });
  ws.on('error', (err) => log('server_error', { message: err.message }));
  // 回線が黙って切れたことに気づくための生存確認
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const hb = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return clearInterval(hb);
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 5000);
  ws.on('close', () => clearInterval(hb));
}

log('agent_start', { serverUrl: cfg.serverUrl, obsUrl: cfg.obsUrl, platform: process.platform, node: process.version });
await connectObs();
connectServer();
