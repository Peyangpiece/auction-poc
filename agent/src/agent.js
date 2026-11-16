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
};
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
});
// OBS の側で配信の状態が変わったら（手で止められた場合も含めて）、サーバーに知らせる
obs.on('StreamStateChanged', (e) => {
  log('obs_stream_state', { outputActive: e.outputActive, outputState: e.outputState });
  if (e.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED' || e.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
    sendToServer({ type: 'agent_state', obsActive: e.outputActive, obsConnected: true, at: now() });
  }
});
setInterval(() => { if (!obsConnected) connectObs(); }, 5000).unref();

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
