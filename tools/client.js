// 負荷をかけるプログラムと自動テストが共通で使う、端末の代わりをするクライアント。
// 実機の入札画面（web/bidder.html）と同じ手順で、時刻合わせ（POC-SRV-006）と測定用の送り返し（POC-SRV-008）を行う。
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

export const localNow = () => performance.timeOrigin + performance.now();

export class Client {
  constructor(url, token, { label = null, ack = true, net = null, autoReconnect = false } = {}) {
    this.autoReconnect = autoReconnect;
    this.reconnects = 0;
    this.url = url;
    this.token = token;
    this.label = label;
    this.ack = ack;
    this.net = net;
    this.offset = 0; // サーバーの時刻 − 端末の時刻
    this.rtt = null;
    this.reqId = 0;
    this.pending = new Map();
    this.handlers = new Set();
    this.lots = new Map();
    this.paddle = null;
    this.log = []; // この端末で測った記録
  }

  serverNow() {
    return localNow() + this.offset;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = (this.ws = new WebSocket(this.url, { perMessageDeflate: false }));
      ws.on('error', reject);
      ws.on('open', () => { this.closed = false; ws.send(JSON.stringify({ type: 'hello', token: this.token, label: this.label })); });
      ws.on('close', () => {
        for (const p of this.pending.values()) p.reject(new Error('closed'));
        this.pending.clear();
        this.closed = true;
        // 負荷の検証（P2-7）用: 切れたら1秒後に接続し直し、回数を数える
        if (this.autoReconnect && !this.closing) {
          this.reconnects++;
          setTimeout(() => this.connect().then(() => this.syncClock()).catch(() => {}), 1000);
        }
      });
      ws.on('message', (raw) => {
        const at = localNow();
        const msg = JSON.parse(raw);
        this.#onMessage(msg, at);
        if (msg.type === 'welcome') resolve(msg);
        if (msg.type === 'error' && !this.paddle && !this.role) reject(new Error(msg.message));
      });
    });
  }

  #onMessage(msg, at) {
    switch (msg.type) {
      case 'welcome':
      case 'snapshot':
        this.role = msg.role ?? this.role;
        this.paddle = msg.paddle ?? this.paddle;
        for (const lot of msg.lots) this.lots.set(lot.id, lot);
        break;
      case 'lot':
        this.lots.set(msg.lot.id, msg.lot);
        break;
      case 'price': {
        const lot = this.lots.get(msg.lotId);
        if (lot) Object.assign(lot, { currentPrice: msg.currentPrice, minBid: msg.minBid, highestPaddle: msg.paddle });
        if (this.ack) this.send({ type: 'price_ack', seq: msg.seq, at: at + this.offset, net: this.net });
        break;
      }
      case 'result':
        if (msg.lot) this.lots.set(msg.lotId, msg.lot);
        if (this.ack) this.send({ type: 'result_ack', lotId: msg.lotId, at: at + this.offset, net: this.net });
        break;
      case 'bid_result':
      case 'comment_result':
      case 'cmd_result':
      case 'time': {
        const key = msg.type === 'time' ? `t${msg.t0}` : msg.reqId;
        const p = this.pending.get(key);
        if (p) {
          this.pending.delete(key);
          p.resolve({ ...msg, clientRecvAt: at });
        }
        break;
      }
    }
    for (const h of this.handlers) h(msg, at);
  }

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  #request(key, obj) {
    return new Promise((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
      this.send(obj);
    });
  }

  /** 時刻合わせ: 5回問い合わせ、往復の時間が最も短かった回の値を使う【提案値】 */
  async syncClock(times = 5) {
    let best = null;
    for (let i = 0; i < times; i++) {
      const t0 = localNow();
      const res = await this.#request(`t${t0}`, { type: 'time', t0 });
      const rtt = res.clientRecvAt - t0;
      // 往復の時間の半分を片道の遅れとみなす
      const offset = res.ts - (t0 + rtt / 2);
      if (!best || rtt < best.rtt) best = { rtt, offset };
    }
    this.offset = best.offset;
    this.rtt = best.rtt;
    return best;
  }

  /** 入札する。結果（受理・拒否）が返るまで待つ。 */
  async bid(lotId, amount) {
    const reqId = ++this.reqId;
    const sentLocal = localNow();
    const res = await this.#request(reqId, {
      type: 'bid', reqId, lotId, amount, clientSentAt: sentLocal, clientSentAtCorrected: sentLocal + this.offset,
    });
    const rec = {
      lotId, amount, seq: res.seq, accepted: res.accepted, code: res.code,
      sentAt: sentLocal + this.offset, roundTripMs: res.clientRecvAt - sentLocal,
    };
    this.log.push(rec);
    return { ...res, ...rec };
  }

  /** コメントを書き込む */
  comment(text) {
    const reqId = ++this.reqId;
    return this.#request(reqId, { type: 'comment', reqId, text });
  }

  /** 進行役の操作 */
  cmd(action, extra = {}) {
    const reqId = ++this.reqId;
    const sentLocal = localNow();
    return this.#request(reqId, {
      type: 'cmd', reqId, action, ...extra, clientSentAt: sentLocal, clientSentAtCorrected: sentLocal + this.offset,
    });
  }

  /** 条件に合うメッセージが届くまで待つ */
  waitFor(pred, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handlers.delete(h);
        reject(new Error('waitFor: timeout'));
      }, timeoutMs);
      const h = (msg, at) => {
        if (!pred(msg)) return;
        clearTimeout(timer);
        this.handlers.delete(h);
        resolve({ ...msg, clientRecvAt: at });
      };
      this.handlers.add(h);
    });
  }

  close() {
    this.closing = true;
    this.ws?.close();
  }
}
