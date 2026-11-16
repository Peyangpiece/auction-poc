// 入札サーバーの入口。HTTP（検証用の画面・EventBridge の受け口）と WebSocket（端末・進行コンソール・配信エージェント）。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { openDb, hashToken } from './db.js';
import { Metrics } from './metrics.js';
import { StreamControl } from './stream.js';
import { Auction } from './auction.js';
import { nowMs } from './clock.js';

const config = loadConfig();
const store = openDb(config.dbPath);
const metrics = new Metrics(config.metricsDir);

// ---------------------------------------------------------------- 接続の管理
const clients = new Set(); // { ws, role: 'member'|'auctioneer', member?, staff?, id }
let connSeq = 0;

/** 全端末へ同じ内容を送る。会場とオンラインで分けない。送り出した時刻を返す。 */
function broadcast(msg) {
  const sentAt = nowMs();
  const text = JSON.stringify({ ...msg, sentAt });
  for (const c of clients) if (c.ws.readyState === 1) c.ws.send(text);
  return nowMs();
}

function presence() {
  let members = 0;
  for (const c of clients) if (c.role === 'member') members++;
  const text = JSON.stringify({ type: 'presence', members, connections: clients.size });
  for (const c of clients) if (c.role === 'auctioneer' && c.ws.readyState === 1) c.ws.send(text);
}

// ---------------------------------------------------------------- 障害の模擬（P2-3、P2-5）
let armedCrash = config.allowCrash ? config.crashAt : '';
function crashNow(point) {
  // 後始末を一切させずに落とす（電源断や kill -9 と同じ条件にする）
  metrics.write('crash', { point });
  process.kill(process.pid, 'SIGKILL');
}
function crashPoint(point) {
  if (armedCrash && armedCrash === point) crashNow(point);
}

// ---------------------------------------------------------------- コメント
// 入札とは別の処理。入札の順番や締めには一切関わらない（遅れても落ちても、競りの結果は変わらない）。
const lastCommentAt = new Map(); // member id -> 最後に書き込んだ時刻
function onComment(conn, msg, send) {
  const fail = (message) => send({ type: 'comment_result', reqId: msg.reqId ?? null, ok: false, message });
  if (conn.role !== 'member') return fail('コメントは会員だけが書き込めます');
  // 制御文字を除き、前後の空白を落とす。長さは文字（書記素ではなくコードポイント）で数える
  const text = String(msg.text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!text) return fail('コメントを入力してください');
  if ([...text].length > config.commentMaxLength) return fail(`コメントは${config.commentMaxLength}文字までです`);
  const now = nowMs();
  const wait = config.commentIntervalMs - (now - (lastCommentAt.get(conn.member.id) ?? 0));
  if (wait > 0) return fail(`続けて書き込むには、あと${Math.ceil(wait / 1000)}秒お待ちください`);
  lastCommentAt.set(conn.member.id, now);
  const lotId = auction.snapshot().focusLotId;
  const info = store.q.insertComment.run(lotId, conn.member.id, text, now);
  send({ type: 'comment_result', reqId: msg.reqId ?? null, ok: true });
  broadcast({ type: 'comment', id: Number(info.lastInsertRowid), paddle: conn.member.paddle_no, text, at: now });
  metrics.write('comment', { paddle: conn.member.paddle_no, length: [...text].length });
}

const stream = new StreamControl({ config, metrics, broadcast });
const auction = new Auction({ store, config, metrics, broadcast, stream, crashPoint });
const recovered = auction.recover();
if (recovered.length) console.log('[recovery]', JSON.stringify(recovered));

// ---------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.webp': 'image/webp', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, now: nowMs(), connections: clients.size }));
  }
  if (url.pathname === '/hooks/ivs' && req.method === 'POST') return handleEventBridge(req, res);
  if (req.method !== 'GET') return res.writeHead(405).end();

  const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
  const file = path.join(config.webDir, name);
  fs.readFile(file, (err, body) => {
    if (err) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  });
});

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function handleEventBridge(req, res) {
  if (!config.eventbridgeSecret || !safeEqual(req.headers['x-poc-secret'] ?? '', config.eventbridgeSecret)) {
    return res.writeHead(403).end();
  }
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 65536) req.destroy();
  });
  req.on('end', () => {
    try {
      stream.onEventBridge(JSON.parse(body));
      res.writeHead(200).end('ok');
    } catch {
      res.writeHead(400).end();
    }
  });
}

// ---------------------------------------------------------------- WebSocket
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const agentWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => onClient(ws, req));
  } else if (url.pathname === '/agent') {
    // エージェントは、接続のときにトークンを Authorization ヘッダーで示す
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const staff = token ? store.q.staffByToken.get(hashToken(token)) : null;
    if (!staff || staff.role !== 'agent') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    agentWss.handleUpgrade(req, socket, head, (ws) => stream.attachAgent(ws, staff.name));
  } else {
    socket.destroy();
  }
});

function onClient(ws, req) {
  const conn = { ws, role: null, member: null, staff: null, id: ++connSeq, ip: req.socket.remoteAddress };
  const send = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // 時刻合わせ（POC-SRV-006）: すぐにサーバーの時刻を返す。認証の前でも答える。
    if (msg.type === 'time') return send({ type: 'time', t0: msg.t0, ts: nowMs() });

    if (msg.type === 'hello') {
      const hash = hashToken(msg.token ?? '');
      const member = store.q.memberByToken.get(hash);
      const staff = member ? null : store.q.staffByToken.get(hash);
      if (!member && !(staff && staff.role === 'auctioneer')) {
        send({ type: 'error', message: '合言葉（トークン）が正しくありません' });
        return ws.close(4401, 'unauthorized');
      }
      conn.role = member ? 'member' : 'auctioneer';
      conn.member = member ?? null;
      conn.staff = staff ?? null;
      clients.add(conn);
      metrics.write('connect', { conn: conn.id, role: conn.role, paddle: member?.paddle_no ?? null, label: msg.label ?? null });
      send({
        type: 'welcome', role: conn.role, paddle: member?.paddle_no ?? null, name: (member ?? staff).name,
        conn: conn.id, serverTime: nowMs(), stream: stream.view(), allowCrash: config.allowCrash,
        playerScriptUrl: config.ivsPlayerScriptUrl, venueContact: config.venueContact,
        commentMaxLength: config.commentMaxLength, comments: store.q.recentComments.all(), ...auction.snapshot(),
      });
      return presence();
    }
    if (!conn.role) return send({ type: 'error', message: '先に hello を送ってください' });

    switch (msg.type) {
      case 'sync': // 再接続のあとなどに、最新の状態を取り直す（FR-UI-002）
        return send({ type: 'snapshot', serverTime: nowMs(), stream: stream.view(), comments: store.q.recentComments.all(), ...auction.snapshot() });
      case 'bid':
        // 主催者側のスタッフは入札できない（FR-CON-004）
        if (conn.role !== 'member') return send({ type: 'error', message: 'スタッフは入札できません' });
        return auction.receiveBid(conn.member, msg, send);
      // ---- 測定用の送り返し（POC-SRV-008、POC-UI-006）
      case 'price_ack':
        return metrics.write('price_ack', { seq: msg.seq, conn: conn.id, paddle: conn.member?.paddle_no ?? null, clientAt: msg.at, net: msg.net ?? null });
      case 'result_ack':
        return metrics.write('result_ack', { lotId: msg.lotId, conn: conn.id, role: conn.role, paddle: conn.member?.paddle_no ?? null, clientAt: msg.at, net: msg.net ?? null });
      case 'video_latency':
        return metrics.write('video_latency', { conn: conn.id, paddle: conn.member?.paddle_no ?? null, latencyMs: msg.latencyMs, clientAt: msg.at, net: msg.net ?? null });
      case 'client_event':
        return metrics.write('client_event', { conn: conn.id, paddle: conn.member?.paddle_no ?? null, name: String(msg.name).slice(0, 64), data: msg.data ?? null, clientAt: msg.at ?? null });
      case 'comment':
        return onComment(conn, msg, send);
      case 'cmd':
        if (conn.role !== 'auctioneer') return send({ type: 'error', message: '進行役だけができる操作です' });
        return onAuctioneer(conn, msg, send);
      default:
        return send({ type: 'error', message: `知らないメッセージです: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    if (clients.delete(conn)) {
      metrics.write('disconnect', { conn: conn.id, role: conn.role });
      presence();
    }
  });
  ws.on('error', () => {});
}

function onAuctioneer(conn, msg, send) {
  const ok = (extra = {}) => send({ type: 'cmd_result', reqId: msg.reqId ?? null, ok: true, action: msg.action, ...extra });
  const ng = (message) => send({ type: 'cmd_result', reqId: msg.reqId ?? null, ok: false, action: msg.action, message });
  try {
    switch (msg.action) {
      case 'start': case 'close': case 'suspend': case 'resume': case 'cancel': case 'exclude':
      case 'start_without_video': case 'back_to_waiting':
        return auction.receiveCommand(conn.staff, msg, send);
      case 'stream_start': stream.manual('start'); return ok();
      case 'stream_stop': stream.manual('stop'); return ok();
      case 'stream_status': stream.manual('status'); return ok();
      case 'set_auto_stop': stream.setAutoStopMs(Number(msg.ms)); return ok();
      case 'create_lot': return ok({ lot: auction.createLot(msg) });
      case 'lot_log': return ok({ log: auction.lotLog(Number(msg.lotId)) });
      case 'hide_comment': // 不適切なコメントを全員の画面から消す（記録は残す）
        store.q.hideComment.run(Number(msg.id));
        broadcast({ type: 'comment_hidden', id: Number(msg.id) });
        metrics.write('comment_hidden', { id: Number(msg.id), actor: conn.staff.name });
        return ok();
      case 'mark': // 測定の区切り（どの検証の記録かを後で見分ける）
        metrics.write('mark', { label: String(msg.label), phase: msg.phase ?? null, data: msg.data ?? null });
        return ok();
      case 'crash': {
        if (!config.allowCrash) return ng('この環境では、障害の模擬は無効です（POC_ALLOW_CRASH=1 で有効）');
        if (msg.point === 'now') return crashNow('now');
        if (msg.point !== 'before_close_record' && msg.point !== 'after_close_record') return ng('point が正しくありません');
        armedCrash = msg.point;
        return ok({ armed: armedCrash });
      }
      default:
        return ng(`知らない操作です: ${msg.action}`);
    }
  } catch (err) {
    return ng(err.message);
  }
}

// ---------------------------------------------------------------- 起動
if (config.ivsMode === 'aws') {
  if (!config.ivsChannelArn) throw new Error('POC_IVS_MODE=aws のときは IVS_CHANNEL_ARN が要ります');
  await stream.startPolling();
}

// CPU・メモリの推移（P2-8、P2-9）
let lastCpu = process.cpuUsage();
let lastAt = nowMs();
const sysTimer = setInterval(() => {
  const cpu = process.cpuUsage();
  const at = nowMs();
  const mem = process.memoryUsage();
  metrics.write('sys', {
    rss: mem.rss, heapUsed: mem.heapUsed, external: mem.external,
    cpuPct: Math.round((((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / 1000 / (at - lastAt)) * 1000) / 10,
    load1: os.loadavg()[0], freeMem: os.freemem(), connections: clients.size,
  });
  lastCpu = cpu;
  lastAt = at;
}, config.sysSampleMs);
sysTimer.unref();

server.listen(config.port, config.host, () => {
  console.log(`[server] listening on ${config.host}:${server.address().port} ivsMode=${config.ivsMode} db=${config.dbPath}`);
  console.log(`[server] metrics -> ${metrics.file}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    stream.stop();
    for (const c of clients) c.ws.close(1001, 'server shutdown');
    server.close();
    await metrics.close();
    store.db.close();
    process.exit(0);
  });
}
