// 検証用の画面の共通部品（本番には引き継がない）: 接続、再接続、時刻合わせ。
'use strict';

// 金額と時刻は Intl で整形する（金額は全桁をそのまま表示する。隠さない・並べ替えない）
const yenFmt = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' });
const timeFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false });
const hmFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const yen = (n) => (n === null || n === undefined ? '—' : yenFmt.format(n).replace('￥', '¥'));
const jst = (ms) => timeFmt.format(ms); // 表示は日本時間（DATA-002）
const jstShort = (ms) => hmFmt.format(ms);
const localNow = () => performance.timeOrigin + performance.now();
const params = new URLSearchParams(location.search);

const STATE_LABEL = {
  waiting: '待機', preparing: '配信準備中', preparing_warn: '配信準備中（警告）', open: '受付中',
  suspended: '中断', sold: '落札', unsold: '流札', not_held: '未実施',
};

class Link {
  constructor({ token, label, onMessage, onStatus }) {
    this.token = token;
    this.label = label;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.offset = 0; // サーバーの時刻 − 端末の時刻
    this.rtt = null;
    this.reqId = 0;
    this.waiters = new Map();
    this.attempt = 0;
    this.downAt = null;
    this.onlineAt = null;
    this.everConnected = false;
    window.addEventListener('online', () => { this.onlineAt = localNow(); });
    // 生存確認: 回線が黙って切れると、ブラウザは切断になかなか気づかない。
    // 3秒ごとにサーバーへ問い合わせ、最後に何かを受け取ってから7秒たっていたら、切れたものとして扱う。
    this.lastHeardAt = localNow();
    setInterval(() => {
      if (this.downAt !== null || this.ws.readyState !== 1) return;
      // 裏に回ったタブでは、ブラウザがタイマーを間引くので判定しない（表に戻ったときに数え直す）
      if (document.hidden) { this.lastHeardAt = localNow(); return; }
      if (localNow() - this.lastHeardAt > 7000) return this.dropped('heartbeat');
      this.send({ type: 'time', t0: 0 });
    }, 3000);
    setInterval(() => this.syncClock(), 30000); // 30秒ごとに時刻を合わせ直す【提案値】
    this.connect();
  }

  serverNow() { return localNow() + this.offset; }
  get up() { return this.ws.readyState === 1 && this.downAt === null; }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = (this.ws = new WebSocket(`${proto}//${location.host}/ws`));
    ws.onopen = () => { this.lastHeardAt = localNow(); ws.send(JSON.stringify({ type: 'hello', token: this.token, label: this.label })); };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return; // 見切りをつけた古い接続からの遅れた受信は捨てる
      const at = localNow();
      this.lastHeardAt = at;
      const msg = JSON.parse(ev.data);
      if (msg.type === 'time' || msg.type === 'bid_result' || msg.type === 'cmd_result' || msg.type === 'comment_result') {
        const key = msg.type === 'time' ? 't' + msg.t0 : msg.reqId;
        const w = this.waiters.get(key);
        if (w) { this.waiters.delete(key); w({ ...msg, clientRecvAt: at }); }
        if (msg.type === 'time') return;
      }
      if (msg.type === 'welcome') {
        const wasDown = this.downAt;
        this.attempt = 0;
        this.downAt = null;
        this.onStatus(true, null, !!wasDown && this.everConnected);
        this.syncClock().then(() => {
          if (wasDown && this.everConnected) {
            // 再接続にかかった時間（P3-5）: 切れてから／回線が戻ってから
            this.event('reconnect', {
              downMs: Math.round(at - wasDown), cause: this.lastDropCause,
              sinceOnlineMs: this.onlineAt && this.onlineAt > wasDown ? Math.round(at - this.onlineAt) : null,
            });
          }
          this.everConnected = true;
        });
      }
      this.onMessage(msg, at);
    };
    ws.onclose = (ev) => {
      if (ws !== this.ws) return; // すでに見切りをつけて、つなぎ直しに入っている
      if (ev.code === 4401) return this.onStatus(false, '合言葉（トークン）が正しくありません');
      this.dropped('close');
    };
    ws.onerror = () => {};
  }

  /** 切れたときの処理。ブラウザが切断を知らせてきた場合も、生存確認で見切りをつけた場合も、ここを通る */
  dropped(cause) {
    const old = this.ws;
    this.ws = { readyState: 3, send() {}, close() {} }; // つなぎ直すまでの間の、何もしない代わり
    try { old.close(); } catch {}
    if (this.downAt === null) this.downAt = localNow();
    this.lastDropCause = cause;
    // 応答を待っている操作（入札など）を、時間切れまで待たせない。届いたかどうかは、再接続後の表示で分かる
    for (const [key, w] of this.waiters) { this.waiters.delete(key); w(null); }
    this.onStatus(false);
    // 切れてから1秒後に1回目を試し、その後は2秒ごとに試す（FR-UI-001）
    setTimeout(() => this.connect(), this.attempt++ === 0 ? 1000 : 2000);
  }

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  request(key, obj, timeoutMs = 10000) {
    return new Promise((resolve) => {
      this.waiters.set(key, resolve);
      this.send(obj);
      setTimeout(() => { if (this.waiters.delete(key)) resolve(null); }, timeoutMs);
    });
  }

  /** 5回問い合わせ、往復の時間が最も短かった回の値を使う（POC-SRV-006） */
  async syncClock() {
    if (this.ws.readyState !== 1) return;
    let best = null;
    for (let i = 0; i < 5; i++) {
      const t0 = localNow();
      const res = await this.request('t' + t0, { type: 'time', t0 }, 3000);
      if (!res) continue;
      const rtt = res.clientRecvAt - t0;
      if (!best || rtt < best.rtt) best = { rtt, offset: res.ts - (t0 + rtt / 2) };
    }
    if (best) { this.offset = best.offset; this.rtt = best.rtt; }
    return best;
  }

  event(name, data) {
    this.send({ type: 'client_event', name, data, at: this.serverNow() });
  }
}
