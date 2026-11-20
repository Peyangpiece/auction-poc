// 検証用の画面の共通部品（本番には引き継がない）: 接続、再接続、時刻合わせ。
'use strict';
/** 入力中に区切り（, や -）を付け直しても、カーソルを、同じ数字のあとに戻す（末尾へ飛ばない。報告書 82 章） */
function setKeepCaret(input, text) {
  const at = input.selectionStart ?? input.value.length;
  const digitsBefore = input.value.slice(0, at).replace(/[^0-9０-９]/g, '').length;
  input.value = text;
  if (document.activeElement !== input) return;
  let pos = 0, seen = 0;
  while (pos < text.length && seen < digitsBefore) { if (/[0-9]/.test(text[pos])) seen++; pos++; }
  try { input.setSelectionRange(pos, pos); } catch { /* 選べない種類の欄 */ }
}

// 金額と時刻は Intl で整形する（金額は全桁をそのまま表示する。隠さない・並べ替えない）
const yenFmt = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' });
const timeFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false });
const hmFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const yen = (n) => (n === null || n === undefined ? '—' : yenFmt.format(n).replace('￥', '¥'));
const jst = (ms) => timeFmt.format(ms); // 表示は日本時間（DATA-002）
const jstShort = (ms) => hmFmt.format(ms);
const localNow = () => performance.timeOrigin + performance.now();
const params = new URLSearchParams(location.search);

/**
 * 参加用の合言葉を、URL に残さない。
 * 開いた直後に URL から取り出して、このタブの中だけに覚えさせ、アドレス欄と履歴からは消す
 * （画面の共有・スクリーンショット・履歴から漏れにくくする）。再読み込みしても、同じタブなら使える。
 */
function takeToken(key) {
  let token = params.get('t');
  try {
    if (token) sessionStorage.setItem(key, token);
    else token = sessionStorage.getItem(key);
  } catch { /* 保存できない設定でも、そのまま使えるようにする */ }
  if (params.has('t')) {
    params.delete('t');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : ''));
  }
  return token;
}
// サーバーが接続を切った理由（つなぎ直しても同じ結果になるもの）
const CLOSE_REASON = {
  4401: 'URL が正しくありません',
  4403: '参加手続きが済んでいないか、ログインが切れています。開き直してください',
  4409: '同時に開ける画面の数を超えました',
  4429: '送信が多すぎるため、接続を切りました',
};

// 切られたときに、次に行く先（報告書 80 章）。サーバーが切る直前に送った理由（code）で決める
// page: 'bidder' | 'console' | 'caller' | 'monitor'
function overlayAction(code, page) {
  const staffPage = page !== 'bidder';
  if (code === 'LOGIN' || code === 'SIGNED_OUT') return staffPage ? { href: `/staff.html?next=${page}`, text: 'ログインし直す' } : { href: '/login.html?next=bidder', text: 'ログインし直す' };
  if (code === 'FORBIDDEN') return { href: '/staff.html', text: '管理の画面に戻る' };
  if (code === 'NOT_JOINED' || code === 'NOT_CHECKED_IN') return { href: '/bidder.html', text: '開き直す' };
  if (code === 'NO_EVENT') return { href: '/mypage.html', text: 'マイページへ' };
  return null;
}
/** 接続の状態を、画面いっぱいの帯で出す。行き先があれば、ボタンを付ける */
function showOverlay(up, why, code, page) {
  document.getElementById('overlay').style.display = up ? 'none' : 'flex';
  // 帯を出しているあいだは、後ろの画面に Tab で移れないようにする（押しても通らない操作に、迷い込まないように。報告書 82 章）
  for (const node of document.body.children) if (node.id !== 'overlay' && node.id !== 'gate' && !['SCRIPT', 'DIALOG'].includes(node.tagName)) node.inert = !up;
  const text = document.getElementById('overlayText');
  text.textContent = why ?? '再接続中…';
  let a = document.getElementById('overlayAction');
  const act = up ? null : overlayAction(code, page);
  if (!act) { a?.remove(); return; }
  if (!a) { a = document.createElement('a'); a.id = 'overlayAction'; a.className = 'btn btn-primary overlay__action'; text.after(a); }
  a.href = act.href; a.textContent = act.text;
}

const STATE_LABEL = {
  waiting: '待機', preparing: '配信準備中', preparing_warn: '配信準備中（警告）', open: '受付中',
  suspended: '中断', sold: '落札', unsold: '流札', not_held: '未実施',
};

class Link {
  constructor({ token, label, onMessage, onStatus, as = undefined }) {
    this.token = token;
    this.as = as; // 'console' なら、スタッフのログインで名乗る
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
    ws.onopen = () => { this.lastHeardAt = localNow(); ws.send(JSON.stringify({ type: 'hello', token: this.token ?? undefined, label: this.label, as: this.as })); };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return; // 見切りをつけた古い接続からの遅れた受信は捨てる
      const at = localNow();
      this.lastHeardAt = at;
      const msg = JSON.parse(ev.data);
      if (msg.type === 'error' && msg.code) this.closeInfo = { code: msg.code, message: msg.message }; // 切られる直前に届く理由
      if (msg.type === 'time' || msg.type === 'bid_result' || msg.type === 'cmd_result' || msg.type === 'comment_result') {
        const key = msg.type === 'time' ? 't' + msg.t0 : msg.reqId;
        const w = this.waiters.get(key);
        if (w) { this.waiters.delete(key); w({ ...msg, clientRecvAt: at }); }
        if (msg.type === 'time') return;
      }
      if (msg.type === 'welcome') {
        this.closeInfo = null;
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
      if (ev.code === 4503) return this.dropped('busy'); // 混み合っている: 少し待って、つなぎ直す
      if (CLOSE_REASON[ev.code]) { // つなぎ直さない。サーバーが理由を送っていれば、その文を出す（固定の文では、何が起きたか分からないため）
        this.ws = { readyState: 3, send() {}, close() {} };
        const info = ev.code === 4403 ? this.closeInfo : null;
        return this.onStatus(false, info?.message ?? CLOSE_REASON[ev.code], false, info?.code ?? null);
      }
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
    this.onStatus(false, cause === 'busy' ? '混み合っています。自動でつなぎ直します' : undefined);
    // 切れてから約1秒後に1回目を試し、その後は約2秒ごとに試す（FR-UI-001）。サーバーの入れ替えで全員が同時に切れても、
    // 同じ瞬間につなぎ直さないように、±0.5秒の幅でばらす（平均は 1秒・2秒のまま。本番運用の評価 C7）。
    // 混み合っているときは、2〜6秒の間でばらして試す
    const jitter = (Math.random() - 0.5) * 1000;
    const wait = cause === 'busy' ? 2000 + Math.random() * 4000 : (this.attempt === 0 ? 1000 : 2000) + jitter;
    this.attempt++;
    setTimeout(() => this.connect(), wait);
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

// 競りの画面を開いているあいだ、10分ごとに、サーバーへ短い問い合わせを送る。
// 入札の通信（WebSocket）だけが続いていると、置き場所によっては「だれも使っていない」と見なされて、サーバーが休んでしまうため
setInterval(() => { fetch('/healthz', { cache: 'no-store' }).catch(() => {}); }, 10 * 60 * 1000);
