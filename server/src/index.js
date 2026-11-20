// 入札サーバーの入口。HTTP（検証用の画面・EventBridge の受け口）と WebSocket（端末・進行コンソール・配信エージェント）。
import http from 'node:http';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { openDb, hashToken } from './db.js';
import { createSaver, storePut, storeDel, RESTORE_NOTE } from './persist.js';
import { createJournal } from './journal.js';
import { Metrics } from './metrics.js';
import { StreamControl } from './stream.js';
import { Auction } from './auction.js';
import { nowMs } from './clock.js';
import { createApi } from './mvp/api.js';
import { clientIp } from './mvp/security.js';

const config = loadConfig();
const store = openDb(config.dbPath);
// 配信エージェントの合言葉（報告書 94 章）。本番では GitHub の Secrets から渡す。
// 入っていれば、これだけを配信エージェントとして登録し、ほかの合言葉（前の値・開発用）は使えなくする
if (config.agentToken) {
  if (config.agentToken.length < 32) console.error('[agent] POC_AGENT_TOKEN が短すぎます（32文字以上）。登録しません');
  else store.db.transaction(() => {
    const hash = hashToken(config.agentToken);
    store.db.prepare("DELETE FROM staff WHERE role = 'agent' AND token_hash <> ?").run(hash);
    if (!store.q.staffByToken.get(hash)) store.q.insertStaff.run('agent', '配信エージェント', hash);
  })();
}
// 外の保存先への保存（Cloudflare など、置き場が消える環境だけ）
// 書き込みの控え: 受理した入札や落札を、返事の前に、外の保存先にも書く（データの置き場が消える環境で、失わないため）
let journalAlert = null; // 保存先に届かなくなったときの知らせ（api ができてから入れる）
const journal = config.persistUrl && config.journal
  ? createJournal({ db: store.db, put: (rel, body) => storePut(config, rel, body), del: (rel) => storeDel(config, rel), maxWaitMs: config.journalMaxWaitMs, onDegraded: (on, why) => journalAlert?.(on, why) })
  : null;
const saver = config.persistUrl ? createSaver({ db: store.db, config, journal }) : null;
// 利用者へ送る: 書き込みの控えが保存先に届いてから送る（届いていれば、すぐ送る）。順番は、変わらない
const out = (ws, text) => {
  if (!journal || journal.clean()) return ws.send(text);
  journal.after(() => { if (ws.readyState === 1) ws.send(text); });
};
const metrics = new Metrics(config.metricsDir, { level: config.metricsLevel, fileMb: config.metricsFileMb, maxMb: config.metricsMaxMb });

// ---------------------------------------------------------------- 接続の管理
let errorCount = 0; // 思いがけないエラーの数（/healthz に出す）
const pending = new Map(); // 名乗る前の接続の数（接続元ごと）
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
    out(c.ws, c.role === 'auctioneer' ? staffText : memberText);
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
  // 参加者の数は、会場とオンラインに分けて出す（FR-CON-002）
  let members = 0, venue = 0;
  for (const c of clients) if (c.role === 'member') { members++; if (c.member?.mode === 'venue') venue++; }
  const text = JSON.stringify({ type: 'presence', members, venue, online: members - venue, connections: clients.size });
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
  // 参加を停止された会員は、コメントも書き込めない（本番運用の評価 S-6）
  if (conn.member.account_id && api.billing.suspension(conn.member.account_id)) return fail('参加が停止されているため、コメントは書き込めません');
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
// 会員登録・ログイン・スタッフ・開催・参加手続き。商品は、進行コンソールからその場で登録する
const api = createApi({ store, config, nowMs, persistStatus: () => saver?.status() ?? null, durable: () => journal?.durable(), healthDetail: () => ({ persist: saver?.status() ?? null, journal: journal?.status() ?? null, journalStarted: journal?.started ?? null }) });
// 本日の開催を終えたあとは、品の登録・開始を断る（開催に属さない品が残り、次の開催を止めないように。本番運用の評価 A6）
const lotGate = () => (api.endedToday() ? '本日の開催は終了しています。品の登録・開始はできません' : null);
const auction = new Auction({ store, config, metrics, broadcast, stream, crashPoint, eventId: api.eventId, bidGate: api.bidGate, lotGate });
// 管理画面からの開催終了（本番運用の評価 A5）
api.hooks.closeOut = (eventId, { current, actor }) => {
  if (current) {
    if (auction.hasActiveLot()) return { error: '進行中の品があるあいだは、開催を終了できません。進行コンソールで締めるか中断してから、やり直してください' };
    return { notHeld: auction.closeOutWaiting(actor) };
  }
  return { notHeld: auction.closeOutEvent(eventId, actor) };
};
api.hooks.afterEnd = (current) => { if (current) { stream.manual('stop'); broadcast({ type: 'event', event: null, ended: true }); } };
const recovered = auction.recover();
if (recovered.length) console.log('[recovery]', JSON.stringify(recovered));

// 起動のときと1時間ごとに、請求の見回りをする（落札の明細の作り漏れ、期限を過ぎた知らせ、受け取り期限の前日の知らせ）
try { api.billing.sweep(); } catch (err) { console.error('[billing]', err); }
// 開催のお知らせメール（前日から当日の開始まで）。送るのに時間がかかるので、待たずに進める
const eventMails = () => api.sendEventMails().catch((err) => console.error('[event-mail]', err));
eventMails();
// 期限の切れた記録（ログイン・認証番号・確認のリンク）を捨てる。たまり続けて、保存のたびに送る量が増えるのを防ぐ
function prune() {
  const now = nowMs(), day = 86400000;
  store.db.prepare("DELETE FROM sessions WHERE last_seen_at < ?").run(now - 401 * day);
  store.db.prepare("DELETE FROM sessions WHERE kind IN ('staff','register') AND last_seen_at < ?").run(now - 30 * day);
  store.db.prepare('DELETE FROM otp_sends WHERE at < ?').run(now - day);
  store.db.prepare('DELETE FROM otp_codes WHERE expires_at < ?').run(now - day);
  store.db.prepare('DELETE FROM email_tokens WHERE expires_at < ?').run(now - day);
}
try { prune(); } catch (err) { console.error('[prune]', err); }
// 保存期間を過ぎた個人情報を消す（退会・却下の会員、監査ログの接続元。本番運用の評価 C）
const purgePii = () => { try { api.purgeExpiredPii(); } catch (err) { console.error('[privacy]', err); } };
purgePii();
setInterval(() => { try { api.billing.sweep(); prune(); } catch (err) { console.error('[billing]', err); } purgePii(); eventMails(); }, 3600000).unref();

// ---------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

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
  // HTTPS で配っているときは、次からも HTTPS だけで開かせる（HSTS）
  ...(config.cookieSecure ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  ...(config.csp === 'off' ? {} : { 'content-security-policy': CSP }),
};
const startedAt = nowMs();
const CAMERA_FAIL = {
  unknown_camera: 'そのカメラは、OBS にありません。OBS のシーンの名前を確かめてください',
  agent_not_connected: '配信エージェントがつながっていないため、切り替えられません',
  timeout: '配信用PCから応答がありません。OBS の画面で確かめてください',
  obs_not_connected: 'OBS につながっていません。配信用PCで OBS が起動しているか確かめてください',
};
const JSQR_FILE = createRequire(import.meta.url).resolve('jsqr/dist/jsQR.js');

const server = http.createServer((req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    let db = true;
    try { store.db.prepare('SELECT 1').get(); } catch { db = false; }
    res.statusCode = db ? 200 : 503;
    // だれでも見られるので、出すのは、死活と、配ってよいか（busy）と、警告の名前だけ。
    // 保存や控えの細かい状態（通し番号・最後に保存した時刻）は、出さない（書き込みがあったかどうかから、登録の有無が分かってしまうため）。
    // 細かい状態は、主催者管理者だけが /api/staff/health で見られる
    return res.end(JSON.stringify({ ok: db, db, now: nowMs(), uptimeSec: Math.round((nowMs() - startedAt) / 1000), connections: clients.size, busy: auction.snapshot().lots.some((l) => ['preparing', 'preparing_warn', 'open', 'suspended'].includes(l.status)) || ['running', 'break'].includes(api.eventState()?.phase), errors: errorCount, agent: stream.view().agentConnected,
      alerts: [...(saver && saver.status().failingSince && nowMs() - saver.status().failingSince > 60000 ? ['persist_failing'] : []), ...(journal?.status().degraded ? ['journal_degraded'] : []), ...(journal && !journal.started ? ['journal_not_started'] : []), ...(config.persistUrl && config.journalReplay === false ? ['journal_replay_off'] : []), ...(restoreNotes.length ? ['restore_incomplete'] : [])],
      ...(journal ? { journal: { degraded: journal.status().degraded, putMs: journal.status().putMs } } : {}) }));
  }
  if (url.pathname === '/hooks/ivs' && req.method === 'POST') return handleEventBridge(req, res);
  if (url.pathname.startsWith('/api/')) return api.handle(req, res, url);
  if (req.method !== 'GET') return res.writeHead(405).end();

  // 最初に開くページは、ログインの画面（発注者の指示）。ログインしていない人がトップページを開いたら、ログインへ送る
  if ((url.pathname === '/' || url.pathname === '/index.html') && !api.signedIn(req)) {
    return res.writeHead(302, { location: '/login.html', 'cache-control': 'no-store' }).end();
  }
  const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
  // QR コードの読み取りの部品（jsQR）は、入れたパッケージから直接返す（受付の画面だけが、読み取るときに読み込む。報告書 91 章）
  const file = name === 'jsqr.js' ? JSQR_FILE : path.join(config.webDir, name);
  // カメラは、受付の画面（QR コードの読み取り）だけに許す。ほかの画面は、これまでどおり使わせない
  if (name === 'staff.html') res.setHeader('permissions-policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
  fs.readFile(file, (err, body) => {
    if (err) {
      // 画面を開こうとした場合（.html か、拡張子なし）は、案内のページを返す。部品（画像・スクリプトなど）は短い返事だけ
      const wantsPage = ['', '.html'].includes(path.extname(name));
      if (!wantsPage) return res.writeHead(404).end('not found');
      return fs.readFile(path.join(config.webDir, '404.html'), (e2, page) => {
        if (e2) return res.writeHead(404).end('not found');
        res.writeHead(404, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        res.end(page);
      });
    }
    const ext = path.extname(file);
    if (!MIME[ext]) return res.writeHead(404).end('not found'); // 画面に使う種類のファイルだけを配る
    // 書体と画像は1日おぼえさせる。画面とスクリプトは、毎回サーバーに確かめさせる（直した内容がすぐ届く）。
    // 中身が同じなら、本体を送り直さない（ETag と 304）。開くたびの通信量と待ち時間が減る
    const cache = ext === '.woff2' || ext === '.webp' || ext === '.png' || ext === '.svg' ? 'public, max-age=86400' : 'no-cache';
    const etag = `"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`;
    if (req.headers['if-none-match'] === etag) return res.writeHead(304, { etag, 'cache-control': cache }).end();
    res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': cache, etag });
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
      if (host !== req.headers.host && !(config.trustProxy && host === req.headers['x-forwarded-host']) && !config.allowedOrigins.includes(origin)) {
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
  const conn = { ws, role: null, member: null, staff: null, id: ++connSeq, ip: clientIp(req, config) };
  // 名乗る前の接続は、同じ接続元から 20 本まで（1人が、空の接続で席を埋めて、ほかの人を入れなくするのを防ぐ）
  const pendingKey = conn.ip;
  pending.set(pendingKey, (pending.get(pendingKey) ?? 0) + 1);
  const leavePending = () => { if (conn.pendingLeft) return; conn.pendingLeft = true; const n = (pending.get(pendingKey) ?? 1) - 1; if (n > 0) pending.set(pendingKey, n); else pending.delete(pendingKey); };
  // 会場の Wi-Fi のように、大勢が同じ接続元から一斉につなぎ直すこともある。利用者のせいではないので、4503（混雑）で切り、画面は少し待ってつなぎ直す（報告書 81 章）
  if (pending.get(pendingKey) > 20) { leavePending(); return ws.close(4503, 'busy'); }
  // 時刻合わせの返事は、待たせない（往復の時間を測るため）。ほかは、書き込みの控えが届いてから送る
  const send = (msg) => { if (ws.readyState !== 1) return; if (msg.type === 'time') ws.send(JSON.stringify(msg)); else out(ws, JSON.stringify(msg)); };
  const allow = limiter(config.messageRate);
  // 名乗らないままの接続を残さない
  const helloTimer = config.helloTimeoutMs > 0 ? setTimeout(() => { if (!conn.role) ws.close(4408, 'hello timeout'); }, config.helloTimeoutMs) : null;

  // 1通の処理でエラーが起きても、サーバーは止めない（その1通だけを断る）
  ws.on('message', (raw) => {
    try { onMessage(raw); } catch (err) {
      console.error('[ws]', err);
      metrics.write('message_error', { conn: conn.id, message: String(err?.message ?? err) });
      send({ type: 'error', message: '処理できませんでした。画面を開き直して、もう一度お試しください' });
    }
  });
  // ログインが切れた人（ログアウト・停止・パスワードの変更・期限切れ）は、開いたままの画面からも、操作できない
  const stillSignedIn = () => {
    if (!conn.recheck || conn.recheck()) return true;
    send({ type: 'error', code: 'SIGNED_OUT', message: 'ログインが切れました。ログインし直してください' });
    ws.close(4403, 'signed out');
    return false;
  };
  const onMessage = (raw) => {
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
      // 合言葉（検証用の URL と、進行役）で名乗るか、合言葉なしで、ログインのクッキーと参加手続きで名乗る
      let member = null, staff = null;
      if (msg.token) {
        if (!config.tokenLogin) {
          send({ type: 'error', message: 'この環境では、合言葉（トークン）では入れません。ログインしてください' });
          return ws.close(4401, 'unauthorized');
        }
        const hash = hashToken(msg.token);
        member = store.q.memberByToken.get(hash) ?? null;
        staff = member ? null : store.q.staffByToken.get(hash) ?? null;
        if (!member && !(staff && staff.role === 'auctioneer')) {
          send({ type: 'error', message: '合言葉（トークン）が正しくありません' });
          return ws.close(4401, 'unauthorized');
        }
      } else if (msg.as === 'console') {
        // 進行コンソール: スタッフのログイン（主催者管理者・進行役）で名乗る
        const found = api.staffFromCookie(req);
        if (!found.staff) {
          send({ type: 'error', code: found.code, message: found.message });
          return ws.close(4403, found.code);
        }
        staff = found.staff;
        conn.recheck = () => api.staffFromCookie(req).staff?.id === staff.id;
      } else if (msg.as === 'monitor') {
        // 会場の大型モニター: スタッフのログインで名乗る。見るだけで、操作も入札もできない
        const found = api.viewerFromCookie(req);
        if (!found.staff) {
          send({ type: 'error', code: found.code, message: found.message });
          return ws.close(4403, found.code);
        }
        staff = found.staff;
        conn.viewer = true;
        conn.recheck = () => api.viewerFromCookie(req).staff?.id === staff.id;
      } else {
        const found = api.participantFromCookie(req);
        if (!found.member) {
          send({ type: 'error', code: found.code, message: found.message });
          return ws.close(4403, found.code);
        }
        member = found.member;
        // 参加の手続きは、入札のたびに別に確かめている（bidGate）。ここでは、ログインが続いているかだけを見る
        const accountId = api.memberIdFromCookie(req);
        conn.recheck = () => api.memberIdFromCookie(req) === accountId;
      }
      if (conn.role) return; // 名乗り直しは受け付けない
      // 同じ人の同時接続に上限を置く（合言葉が漏れたときに、際限なくつながれないようにする）
      const userKey = member ? `member:${member.id}` : `staff:${staff.account ? 'a' : 't'}${staff.id}`;
      const open = userConnections.get(userKey) ?? 0;
      if (config.maxConnectionsPerUser > 0 && open >= config.maxConnectionsPerUser) {
        send({ type: 'error', message: '同時に開ける画面の数を超えました。ほかの画面を閉じてから、開き直してください' });
        return ws.close(4409, 'too many connections');
      }
      userConnections.set(userKey, open + 1);
      conn.userKey = userKey;
      clearTimeout(helloTimer);
      leavePending();
      conn.role = member ? 'member' : conn.viewer ? 'viewer' : 'auctioneer';
      conn.member = member ?? null;
      conn.staff = staff ?? null;
      clients.add(conn);
      metrics.write('connect', { conn: conn.id, role: conn.role, paddle: member?.paddle_no ?? null, label: msg.label ?? null });
      const shape = (m) => (conn.role === 'auctioneer' ? m : forMember(m));
      send(shape({
        type: 'welcome', role: conn.role, paddle: member?.paddle_no ?? null, mode: member?.mode ?? null, name: (member ?? staff).name,
        conn: conn.id, serverTime: nowMs(), stream: stream.view(), allowCrash: config.allowCrash, ladder: config.incrementTable,
        playerScriptUrl: config.ivsPlayerScriptUrl, venueContact: config.venueContact,
        commentMaxLength: config.commentMaxLength, comments: store.q.recentComments.all(api.eventId()), ...auction.snapshot(), event: api.eventState(), ended: api.endedToday(),
        ...(conn.role === 'auctioneer' ? { sold: auction.soldList() } : {}),
      }));
      return presence();
    }
    if (!conn.role) return send({ type: 'error', message: '先に hello を送ってください' });

    switch (msg.type) {
      case 'sync': // 再接続のあとなどに、最新の状態を取り直す（FR-UI-002）
        return send((conn.role === 'auctioneer' ? (m) => m : forMember)({ type: 'snapshot', serverTime: nowMs(), stream: stream.view(), comments: store.q.recentComments.all(api.eventId()), ...auction.snapshot(), event: api.eventState(), ended: api.endedToday() }));
      case 'bid':
        // 主催者側のスタッフは入札できない（FR-CON-004）
        if (conn.role !== 'member') return send({ type: 'error', message: 'スタッフは入札できません' });
        if (!stillSignedIn()) return;
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
        return metrics.write('client_event', { conn: conn.id, paddle: conn.member?.paddle_no ?? null, name: String(msg.name).slice(0, 64), data: msg.data !== undefined && JSON.stringify(msg.data).length <= 2000 ? msg.data : null, clientAt: msg.at ?? null });
      case 'comment':
        if (!stillSignedIn()) return;
        return onComment(conn, msg, send);
      case 'cmd':
        if (conn.role !== 'auctioneer') return send({ type: 'error', message: '進行役だけができる操作です' });
        if (!stillSignedIn()) return;
        return onAuctioneer(conn, msg, send);
      default:
        return send({ type: 'error', message: `知らないメッセージです: ${msg.type}` });
    }
  };

  ws.on('close', () => {
    clearTimeout(helloTimer);
    leavePending();
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

// 監査ログに残す操作者。ログインしたスタッフならその人、検証用の合言葉で入った進行役なら「システム」扱い
const staffRef = (conn) => (conn.staff.account ? { id: conn.staff.id, role: conn.staff.role } : null);
const PROXY_REJECT = {
  LOT_NOT_OPEN: 'この品は入札を受け付けていません', AFTER_CLOSE: '締めに間に合いませんでした', TOO_HIGH: '一度に入れられる金額を超えています', BELOW_MINIMUM: '最低入札額より低い金額です',
  OFF_LADDER: '入札できる金額ではありません', ALREADY_HIGHEST: 'この参加者が、すでに最高入札者です', NOT_CHECKED_IN: '受付で、来場の確認を受けてください', SUSPENDED: 'この参加者は、参加が停止されています', NOT_JOINED: 'この参加者は、いまの開催の参加者ではありません',
};
const CALLER_ACTIONS = new Set(['start', 'set_start', 'urikiri', 'close', 'pass', 'suspend', 'resume', 'sold_list']);
function onAuctioneer(conn, msg, send) {
  const sendSold = () => send({ type: 'sold', sold: auction.soldList() });
  const ok = (extra = {}) => send({ type: 'cmd_result', reqId: msg.reqId ?? null, ok: true, action: msg.action, ...extra });
  const ng = (message) => send({ type: 'cmd_result', reqId: msg.reqId ?? null, ok: false, action: msg.action, message });
  // オークショニアは、次の品の開始・中断・再開と、競りの最中の4つの操作（開始価格・うりきり・締め・流札）だけができる（発注者の指示）
  if (conn.staff?.role === 'caller' && !CALLER_ACTIONS.has(msg.action)) return ng('この操作は、オークショニアにはできません');
  try {
    switch (msg.action) {
      case 'start': case 'close': case 'suspend': case 'resume': case 'cancel': case 'exclude':
      case 'start_without_video': case 'back_to_waiting': case 'set_start': case 'urikiri': case 'pass':
        return auction.receiveCommand(conn.staff, msg, (res) => {
          send(res);
          if (!res.ok) return;
          // 競りを始めたら、開催は「進行中」になる（休憩も終わる。FR-EVT-003）
          if (msg.action === 'start' && api.eventState() && api.eventState().phase !== 'running') broadcast({ type: 'event', event: api.setPhase(staffRef(conn), 'running') });
          // 落札の一覧を、進行役に送り直す（受け取り方法・支払方法つき。FR-CON-002）
          // 落札したら、明細を作って、落札者にメールで知らせる（FR-INV-001）
          if (msg.action === 'close' || msg.action === 'pass') { api.billing.syncLines(); sendSold(); }
        });
      case 'sold_list': return ok({ sold: auction.soldList() });
      case 'event_break': { // 休憩（FR-CON-003）: 進行中の品がないときだけ。次の開始予定時刻が要る
        if (auction.hasActiveLot()) return ng('進行中の品があるあいだは、休憩に入れません');
        const at = String(msg.resumeAt ?? '');
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) return ng('次の開始予定時刻を、入力してください');
        broadcast({ type: 'event', event: api.setPhase(staffRef(conn), 'break', at) });
        return ok();
      }
      case 'event_end': { // 開催終了（FR-EVT-003）: 取り消せない
        if (auction.hasActiveLot()) return ng('進行中の品があるあいだは、開催を終了できません');
        if (!api.eventState()) return ng('本日の開催はありません');
        const notHeld = auction.closeOutWaiting(conn.staff.name); // 待機の品は、未実施にする
        stream.manual('stop');                                    // 配信を停止する
        const sold = auction.soldList();
        // まだ精算していない明細を、落札者ごとに1通の振込の請求書にまとめて発行する（FR-INV-004）
        const invoices = api.billing.onEventEnd(api.eventId(), { staff: staffRef(conn), system: true });
        api.setPhase(staffRef(conn), 'ended');
        broadcast({ type: 'event', event: null, ended: true });
        return ok({ notHeld, sold, invoices: invoices.length });
      }
      case 'proxy_bid': { // 緊急用の代理入札（FR-CON-005）
        if (!msg.cardChecked) return ng('参加番号の札を確認して、チェックを入れてください');
        const reason = String(msg.reason ?? '').trim().slice(0, 500);
        if (!reason) return ng('理由を入力してください');
        const target = api.proxyTarget(msg.paddle);
        // 受理の条件は、本人の入札とまったく同じ（同じ処理の列に入れる）
        return auction.receiveBid(target, { lotId: msg.lotId, amount: msg.amount, reqId: msg.reqId }, (res) => {
          api.audit({ staff: staffRef(conn), system: true }, 'proxy.bid', { target: `participant:${target.id}`, after: { lotId: Number(msg.lotId), paddle: target.paddle_no, amount: Number(msg.amount), seq: res.seq, result: res.accepted ? 'ACCEPTED' : res.code }, reason });
          send({ type: 'cmd_result', reqId: msg.reqId ?? null, ok: res.accepted, action: msg.action, seq: res.seq, code: res.code, minBid: res.minBid, message: res.accepted ? undefined : (PROXY_REJECT[res.code] ?? res.code) });
        }, { proxyBy: conn.staff.name });
      }
      case 'proxy_cancel': { // 代理入札の取り消し（FR-CON-006）
        const reason = String(msg.reason ?? '').trim().slice(0, 500);
        return auction.receiveCommand(conn.staff, { ...msg, action: 'cancel_proxy', reason }, (res) => {
          if (res.ok) api.audit({ staff: staffRef(conn), system: true }, 'proxy.cancel', { target: `lot:${Number(msg.lotId)}`, after: { bidSeq: Number(msg.bidSeq) }, reason });
          send({ ...res, action: msg.action });
        });
      }
      // 配信の開始・停止・カメラの切り替え・コメントを消す操作は、だれがしたかを監査ログに残す（本番運用の評価 C）
      case 'stream_start': stream.manual('start'); api.audit({ staff: staffRef(conn), system: true }, 'stream.start', { target: 'stream' }); return ok();
      case 'stream_stop': stream.manual('stop'); api.audit({ staff: staffRef(conn), system: true }, 'stream.stop', { target: 'stream' }); return ok();
      case 'stream_status': stream.manual('status'); return ok();
      case 'camera': { // 映すカメラの切り替え（OBS のシーン。報告書 92 章）。配信は止めない
        const name = String(msg.camera ?? '');
        return stream.setCamera(name).then((res) => (api.audit({ staff: staffRef(conn), system: true }, 'stream.camera', { target: 'stream', after: { camera: name, ok: !!res?.ok } }), send({ type: 'cmd_result', reqId: msg.reqId ?? null, action: 'camera', ok: !!res?.ok,
          message: res?.ok ? undefined : CAMERA_FAIL[res?.error] ?? 'カメラを切り替えられませんでした。OBS の画面で確かめてください' })));
      }
      case 'set_auto_stop': stream.setAutoStopMs(Number(msg.ms)); return ok();
      case 'create_lot': {
        // 商品は、競りの最中にその場で登録する（発注者の決定）。登録は記録に残す。
        const lot = auction.createLot(msg);
        api.audit({ staff: staffRef(conn), system: true }, 'lot.create', { target: `lot:${lot.id}`, after: { via: 'console', staff: conn.staff.id, title: lot.title, startPrice: lot.startPrice } });
        return ok({ lot });
      }
      case 'lot_log': return ok({ log: auction.lotLog(Number(msg.lotId)) });
      case 'hide_comment': // 不適切なコメントを全員の画面から消す（記録は残す）
        store.q.hideComment.run(Number(msg.id));
        broadcast({ type: 'comment_hidden', id: Number(msg.id) });
        metrics.write('comment_hidden', { id: Number(msg.id), actor: conn.staff.name });
        api.audit({ staff: staffRef(conn), system: true }, 'comment.hide', { target: `comment:${Number(msg.id)}` });
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

// 保存先（R2）への保存が1分以上失敗し続けたら、主催者管理者へ知らせる（そのまま止まると、そのあいだの入札が失われるため。本番運用の評価 A7・A8）
if (saver) setInterval(() => {
  const st = saver.status();
  if (st.failingSince && nowMs() - st.failingSince > 60000) {
    api.alertAdmins('persist', '保存先にデータを保存できていません', [
      `${new Date(st.failingSince + 9 * 3600000).toISOString().slice(11, 16)} から、保存先（Cloudflare R2）にデータを保存できていません。`,
      'このあいだにサーバーが止まると、それまでの入札や操作が失われるおそれがあります。',
      '競りの最中なら、新しい品を始めず、進行中の品を締めてから、開発の担当者に連絡してください。',
      `理由: ${st.lastError ?? '不明'}`,
    ]);
  }
}, 30000).unref();

// 書き込みの控えを始める。その前に、いまのデータベース（起動のときの準備の書き込みを含む）の写しを、保存先へ送っておく
if (journal) {
  journalAlert = (on, why) => {
    if (on) api.alertAdmins('journal', '入札の控えを、保存先に書けていません', [
      '受理した入札や落札を、返事の前に、保存先（Cloudflare R2）へ書く処理が、失敗しています。',
      '競りは続けられますが、このあいだにサーバーが止まると、直前の数秒の入札や落札が失われるおそれがあります。',
      '競りの最中なら、進行中の品を締めてから、開発の担当者に連絡してください。',
      `理由: ${why ?? '不明'}`,
    ]);
  };
  // 新しい世代の印をデータベースに書き、その写しが保存先に届いてから、控えを始める（写しと控えが、必ず組になるように）。
  // 写しを送れないあいだは、控えを始めずに、送れるまでやり直す（そのあいだの守りは、前と同じ、約2秒ごとの写しだけ）
  journal.begin();
  const startJournal = async () => {
    await saver.flush();
    if (saver.status().lastError) { setTimeout(startJournal, 2000).unref(); return; }
    journal.start();
  };
  await startJournal();
}
// 復元のときに、知らせることがあった（古い控えから戻した・控えのやり直しが途中で止まった）: 主催者管理者へ知らせ、/healthz にも出す
let restoreNotes = [];
try {
  const file = path.join(config.dataDir, RESTORE_NOTE);
  if (fs.existsSync(file)) {
    restoreNotes = JSON.parse(fs.readFileSync(file, 'utf8')).notes ?? [];
    fs.rmSync(file, { force: true });
    if (restoreNotes.length) {
      console.error('[restore] ' + restoreNotes.join(' / '));
      api.alertAdmins('restore', 'データを戻したときに、一部が戻りませんでした', [...restoreNotes, '競りの前に、直前の入札・落札・精算が正しく残っているかを、確かめてください。']);
    }
  }
} catch (err) { console.error('[restore]', err); }
server.listen(config.port, config.host, () => {
  saver?.start();
  console.log(`[server] listening on ${config.host}:${/** @type {import('node:net').AddressInfo} */ (server.address()).port} ivsMode=${config.ivsMode} db=${config.dbPath}`);
  console.log(`[server] metrics -> ${metrics.file ?? '（記録しない）'}`);
});

// ログインが切れた人（ログアウト・停止・パスワードの変更・期限切れ）の、開いたままの画面を、10秒ごとに見つけて切る。
// 操作のたびにも確かめているが、何もしない画面にも、価格や（スタッフには）最低落札額が届き続けるのを止める
setInterval(() => {
  for (const c of clients) {
    if (!c.recheck || c.ws.readyState !== 1) continue;
    let ok = false;
    try { ok = c.recheck(); } catch { ok = false; }
    if (!ok) { try { c.ws.send(JSON.stringify({ type: 'error', code: 'SIGNED_OUT', message: 'ログインが切れました。ログインし直してください' })); } catch { /* 切れている */ } c.ws.close(4403, 'signed out'); }
  }
}, config.sessionRecheckMs).unref();

// 思いがけないエラーで、サーバーごと止まらないようにする（競りの最中に、全員の接続が切れるのを防ぐ）。記録して、続ける
// 思いがけないエラーは、主催者管理者へも知らせる（1時間に1回まで。中身は、エラーの種類と1行目だけ。本番運用の評価 C3）
function alertUnexpected(label, err) {
  try {
    const first = String(err?.message ?? err).split('\n')[0].slice(0, 200);
    api.alertAdmins('unexpected', 'サーバーで思いがけないエラーが起きました', [
      'サーバーで、思いがけないエラーが起きました。サーバーは止めずに、動かし続けています。',
      '競りの画面と、管理画面の「記録」で、おかしな動きがないかを確かめてください。続くときは、開発の担当者に知らせてください。',
      '', `種類: ${label}（${err?.name ?? 'Error'}）`, `内容: ${first}`, `これまでの件数: ${errorCount}`,
    ]);
  } catch { /* 知らせられなくても、続ける */ }
}
process.on('uncaughtException', (err) => { if (/** @type {any} */ (err)?.syscall === 'listen') { console.error(err); process.exit(1); } errorCount++; console.error('[uncaught]', err); alertUnexpected('uncaughtException', err); });
process.on('unhandledRejection', (err) => { errorCount++; console.error('[unhandled]', err); alertUnexpected('unhandledRejection', err); });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    stream.stop();
    for (const c of clients) c.ws.close(1001, 'server shutdown');
    server.close();
    await metrics.close();
    // 止まる前に、まだ送っていない分を保存先へ送る
    // 1回で送れなければ、送れるまで（50秒まで）くり返す
    if (journal) { await journal.flush(10000); journal.stop(); }
    if (saver) {
      saver.stop();
      const until = Date.now() + 50000;
      do { await saver.flush(); } while (saver.status().pending && Date.now() < until && (await new Promise((r) => setTimeout(r, 1000)), true));
      if (saver.status().pending) console.error('[persist] 止まる前に、送り切れませんでした');
    }
    store.db.close();
    process.exit(0);
  });
}
