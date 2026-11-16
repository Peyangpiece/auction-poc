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
import { createApi } from './mvp/api.js';

const config = loadConfig();
const store = openDb(config.dbPath);
const metrics = new Metrics(config.metricsDir, { level: config.metricsLevel, fileMb: config.metricsFileMb, maxMb: config.metricsMaxMb });

// ---------------------------------------------------------------- 接続の管理
const clients = new Set(); // { ws, role: 'member'|'auctioneer', member?, staff?, id }
let connSeq = 0;

/**
 * 会員に送る前に、最低落札額の金額を必ず落とす。
 * 会員が知るのは「うりきり」（届いたかどうか）だけで、金額は進行役にしか送らない。
 * ロットを含むメッセージはすべてここを通す（1か所で落とすので、送り先ごとの書き忘れが起きない）。
 */
const publicLot = ({ reservePrice, ...rest }) => rest;
function forMember(msg) {
  if (!msg.lot && !msg.lots) return msg;
  const out = { ...msg };
  if (out.lot) out.lot = publicLot(out.lot);
  if (out.lots) out.lots = out.lots.map(publicLot);
  return out;
}

/** 全端末へ送る。入札額・価格・結果は、会場とオンラインで分けない。送り出した時刻を返す。 */
function broadcast(msg) {
  const sentAt = nowMs();
  const staffText = JSON.stringify({ ...msg, sentAt });
  const memberText = msg.lot || msg.lots ? JSON.stringify({ ...forMember(msg), sentAt }) : staffText;
  for (const c of clients) {
    if (c.ws.readyState !== 1) continue;
    // 通信の遅い端末に送信がたまり続けると、サーバーのメモリを圧迫する。たまりすぎた端末は切る（端末はつなぎ直して、最新の状態を取り直す）
    if (config.maxBufferedBytes > 0 && c.ws.bufferedAmount > config.maxBufferedBytes) {
      metrics.write('dropped_slow_client', { conn: c.id, buffered: c.ws.bufferedAmount });
      c.ws.terminate();
      continue;
    }
    c.ws.send(c.role === 'auctioneer' ? staffText : memberText);
  }
  return nowMs();
}

/** 一定の速さまでしか通さない計り（トークンバケット）。rate=1秒あたりの回数、burst=瞬間的に許す回数 */
function limiter(rate, burst = rate * 2) {
  if (!(rate > 0)) return () => true;
  let tokens = burst;
  let last = nowMs();
  return () => {
    const now = nowMs();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * rate);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}
const bidLimiters = new Map(); // 会員ごとの入札の計り（端末を増やしても、1人あたりの上限は変わらない）
const userConnections = new Map(); // 'member:3' -> 同時接続の数

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

// 会員登録・ログイン・スタッフ・商品・審査・カタログ（MVP の 1・2）
const api = createApi({ store, config, nowMs });

// ---------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.webp': 'image/webp', '.png': 'image/png' };

// ブラウザに守らせる制限。スクリプトとスタイルは自分のサイトのファイルだけ（画面の中に直接書いたものは動かない）。
// 映像の再生（Amazon IVS のプレーヤー）に要る許可は、公式の資料を見ずに書いた想定で【未検証】。実物で映像が出なければ、ここを直すか POC_CSP=off にする。
const playerOrigin = (() => { try { return new URL(config.ivsPlayerScriptUrl).origin; } catch { return ''; } })();
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'wasm-unsafe-eval' ${playerOrigin}`.trim(),
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self' blob: https:",
  "connect-src 'self' ws: wss: https:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer', // 参加用の URL が、よそのサイトに伝わらないようにする
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  ...(config.csp === 'off' ? {} : { 'content-security-policy': CSP }),
};
const startedAt = nowMs();

const server = http.createServer((req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    let db = true;
    try { store.db.prepare('SELECT 1').get(); } catch { db = false; }
    res.statusCode = db ? 200 : 503;
    return res.end(JSON.stringify({ ok: db, db, now: nowMs(), uptimeSec: Math.round((nowMs() - startedAt) / 1000), connections: clients.size, agent: stream.view().agentConnected }));
  }
  if (url.pathname === '/hooks/ivs' && req.method === 'POST') return handleEventBridge(req, res);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return api.handle(req, res, url);
  if (req.method !== 'GET') return res.writeHead(405).end();

  const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
  const file = path.join(config.webDir, name);
  fs.readFile(file, (err, body) => {
    if (err) return res.writeHead(404).end('not found');
    const ext = path.extname(file);
    if (!MIME[ext]) return res.writeHead(404).end('not found'); // 画面に使う種類のファイルだけを配る
    // 書体と画像は1日おぼえさせる。画面とスクリプトは毎回取り直す（直した内容がすぐ届く）
    const cache = ext === '.woff2' || ext === '.webp' || ext === '.png' ? 'public, max-age=86400' : 'no-store';
    res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': cache });
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
    // よそのサイトのページからの接続を断る（ブラウザは Origin を必ず付ける。付いていないのは、負荷のプログラムなどブラウザ以外）
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* 形の崩れた Origin は断る */ }
      if (host !== req.headers.host && !config.allowedOrigins.includes(origin)) {
        metrics.write('rejected_origin', { origin });
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
    }
    if (config.maxConnections > 0 && wss.clients.size >= config.maxConnections) {
      metrics.write('rejected_full', { connections: wss.clients.size });
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      return socket.destroy();
    }
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

// 生存確認: 一定の間隔で ping を送り、次の回までに応答（pong）がなかった接続は切る。
// 回線が黙って切れた端末の接続を残さない（参加者の数が正しく出る。送信の滞留もたまらない）。
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, config.heartbeatMs);
heartbeat.unref();

function onClient(ws, req) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const conn = { ws, role: null, member: null, staff: null, id: ++connSeq, ip: req.socket.remoteAddress };
  const send = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const allow = limiter(config.messageRate);
  // 名乗らないままの接続を残さない
  const helloTimer = config.helloTimeoutMs > 0 ? setTimeout(() => { if (!conn.role) ws.close(4408, 'hello timeout'); }, config.helloTimeoutMs) : null;

  ws.on('message', (raw) => {
    // 受信が速すぎる接続は切る（壊れた端末や、わざとの連打からサーバーを守る）
    if (!allow()) {
      metrics.write('rejected_flood', { conn: conn.id, role: conn.role });
      send({ type: 'error', message: '送信が多すぎるため、接続を切りました' });
      return ws.close(4429, 'too many messages');
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg === null || typeof msg !== 'object') return;

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
      if (conn.role) return; // 名乗り直しは受け付けない
      // 同じ人の同時接続に上限を置く（合言葉が漏れたときに、際限なくつながれないようにする）
      const userKey = member ? `member:${member.id}` : `staff:${staff.id}`;
      const open = userConnections.get(userKey) ?? 0;
      if (config.maxConnectionsPerUser > 0 && open >= config.maxConnectionsPerUser) {
        send({ type: 'error', message: '同時に開ける画面の数を超えました。ほかの画面を閉じてから、開き直してください' });
        return ws.close(4409, 'too many connections');
      }
      userConnections.set(userKey, open + 1);
      conn.userKey = userKey;
      clearTimeout(helloTimer);
      conn.role = member ? 'member' : 'auctioneer';
      conn.member = member ?? null;
      conn.staff = staff ?? null;
      clients.add(conn);
      metrics.write('connect', { conn: conn.id, role: conn.role, paddle: member?.paddle_no ?? null, label: msg.label ?? null });
      const shape = (m) => (conn.role === 'auctioneer' ? m : forMember(m));
      send(shape({
        type: 'welcome', role: conn.role, paddle: member?.paddle_no ?? null, name: (member ?? staff).name,
        conn: conn.id, serverTime: nowMs(), stream: stream.view(), allowCrash: config.allowCrash,
        playerScriptUrl: config.ivsPlayerScriptUrl, venueContact: config.venueContact,
        commentMaxLength: config.commentMaxLength, comments: store.q.recentComments.all(), ...auction.snapshot(),
      }));
      return presence();
    }
    if (!conn.role) return send({ type: 'error', message: '先に hello を送ってください' });

    switch (msg.type) {
      case 'sync': // 再接続のあとなどに、最新の状態を取り直す（FR-UI-002）
        return send((conn.role === 'auctioneer' ? (m) => m : forMember)({ type: 'snapshot', serverTime: nowMs(), stream: stream.view(), comments: store.q.recentComments.all(), ...auction.snapshot() }));
      case 'bid':
        // 主催者側のスタッフは入札できない（FR-CON-004）
        if (conn.role !== 'member') return send({ type: 'error', message: 'スタッフは入札できません' });
        {
          // 入札の速さの上限（会員ごと）。人の操作ではありえない速さの入札は、受け付けずに返す。記録にも残さない
          let ok = bidLimiters.get(conn.member.id);
          if (!ok) bidLimiters.set(conn.member.id, (ok = limiter(config.bidRate, Math.max(1, config.bidRate))));
          if (!ok()) {
            metrics.write('rejected_bid_rate', { paddle: conn.member.paddle_no });
            return send({ type: 'bid_result', reqId: msg.reqId ?? null, lotId: Number(msg.lotId), accepted: false, code: 'RATE_LIMITED', amount: Number(msg.amount) });
          }
        }
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
    clearTimeout(helloTimer);
    if (conn.userKey) {
      const left = (userConnections.get(conn.userKey) ?? 1) - 1;
      if (left > 0) userConnections.set(conn.userKey, left); else userConnections.delete(conn.userKey);
    }
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
      case 'create_lot': {
        // 商品は、競りの最中にその場で登録する（発注者の決定）。別の人による事前の審査は通らないので、
        // 出品禁止の言葉が品名に含まれていたら、登録する本人に判断の理由を求め、記録に残す（FR-ITEM-006・007 の趣旨）。
        const words = api.bannedIn(msg.title);
        const reason = String(msg.reason ?? '').trim().slice(0, 1000);
        if (words.length && !reason) {
          return send({ type: 'cmd_result', reqId: msg.reqId ?? null, ok: false, action: msg.action, code: 'BANNED_WORD', words,
            message: `出品禁止の言葉（${words.join('、')}）が含まれています。登録するには、判断の理由が必要です` });
        }
        const lot = auction.createLot(msg);
        api.audit({ system: true }, 'lot.create', { target: `lot:${lot.id}`, after: { via: 'console', staff: conn.staff.id, title: lot.title, startPrice: lot.startPrice, warnings: words }, reason: reason || null });
        return ok({ lot });
      }
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
  console.log(`[server] metrics -> ${metrics.file ?? '（記録しない）'}`);
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
