// 配信の制御（POC-AGT、POC-IVS、本仕様 FR-STR-003、8.6、IF-EXT-001・002）
//
// 入札サーバーは OBS に直接つながない。配信用PCの配信エージェントが外向きに接続してきて、
// サーバーはその接続の上で「配信開始」「配信停止」「状態の問い合わせ」を指示する。
// obs-websocket のパスワードと IVS のストリームキーは、サーバーには一切届かない（POC-AGT-003）。
import { EventEmitter } from 'node:events';
import { nowMs } from './clock.js';

export class StreamControl extends EventEmitter {
  constructor({ config, metrics, broadcast }) {
    super();
    this.config = config;
    this.metrics = metrics;
    this.broadcast = broadcast;
    this.autoStopMs = config.autoStopMs;

    this.agent = null; // 接続中のエージェントの WebSocket
    this.pending = new Map(); // 指示の id -> { resolve, timer, action, sentAt }
    this.cmdId = 0;
    this.obsActive = null; // エージェントが最後に報告した OBS の配信の状態（不明なら null）
    this.desired = null; // サーバーが望む配信の状態（'on' / 'off' / null=まだ指示していない）
    this.cameras = []; // OBS のカメラ（名前が「カメラ」で始まるシーン）。エージェントが知らせてくる（報告書 92 章）
    this.camera = null; // いま映しているシーン

    this.live = { poll: false, event: false, mock: false }; // 方法ごとの「LIVE かどうか」
    this.eventLiveAt = 0;
    this.wasLive = false;
    this.waiting = null; // 配信開始を待っている間の情報 { startedAt, timeoutTimer, settleTimer }
    this.active = false; // 「受付中」「配信準備中」のロットがあるか
    this.idleSince = null; // 競りがなく、配信が動いている状態が始まった時刻
    this.autoStopTimer = null;
    this.autoStopDueAt = null;
    this.pollTimer = null;
    this.mockTimer = null;
  }

  // ------------------------------------------------------------ 状態
  isLive() {
    if (this.config.ivsMode === 'always-live') return true;
    return this.live.poll || this.live.event || this.live.mock;
  }

  view() {
    return {
      mode: this.config.ivsMode,
      live: this.isLive(),
      liveBy: { ...this.live },
      agentConnected: !!this.agent,
      obsActive: this.obsActive,
      cameras: this.cameras,
      camera: this.camera,
      desired: this.desired,
      waiting: !!this.waiting,
      autoStopMs: this.autoStopMs,
      autoStopDueAt: this.autoStopDueAt,
      // 競りがない状態が始まった時刻（競りがある間は null）。進行コンソールが、止め忘れの注意に使う
      idleSince: this.active ? null : this.idleSince,
      idleWarnMs: this.config.streamIdleWarnMs,
      playbackUrl: this.config.ivsPlaybackUrl,
    };
  }

  #publish() {
    this.broadcast({ type: 'stream', stream: this.view() });
  }

  // ------------------------------------------------------------ 競りからの要求
  /** 配信を開始して LIVE を待つ。LIVE になって settle（8秒）経ったら 'ready'、60秒で 'timeout' を出す。 */
  ensureStarted(ctx = {}) {
    if (this.waiting) return;
    const startedAt = nowMs();
    this.waiting = {
      startedAt,
      settleTimer: null,
      timeoutTimer: setTimeout(() => {
        if (!this.waiting || this.waiting.settleTimer) return;
        this.metrics.write('stream_wait_timeout', { startedAt, ...ctx });
        this.emit('timeout');
        this.#publish();
      }, this.config.liveTimeoutMs),
    };
    this.metrics.write('stream_wait_start', { startedAt, ...ctx });
    if (this.isLive()) this.#armSettle();
    this.#command('start', 'auction');
    this.#publish();
  }

  cancelWait() {
    if (!this.waiting) return;
    clearTimeout(this.waiting.timeoutTimer);
    clearTimeout(this.waiting.settleTimer);
    this.waiting = null;
    this.#publish();
  }

  #armSettle() {
    if (!this.waiting || this.waiting.settleTimer) return;
    const liveAt = nowMs();
    this.waiting.settleTimer = setTimeout(() => {
      if (!this.waiting) return;
      if (!this.isLive()) {
        // 待っている間に LIVE でなくなった: もう一度 LIVE を待つ
        this.waiting.settleTimer = null;
        return;
      }
      const startedAt = this.waiting.startedAt;
      this.cancelWait();
      this.metrics.write('stream_ready', { startedAt, liveAt, readyAt: nowMs() });
      this.emit('ready');
    }, this.config.liveSettleMs);
  }

  /** 「受付中」「配信準備中」のロットがあるかどうか。なくなってから autoStopMs 続いたら配信を止める。 */
  setActive(active) {
    const changed = this.active !== active;
    this.active = active;
    if (active) this.idleSince = null;
    else if (changed || this.idleSince === null) this.idleSince = nowMs();
    if (changed) this.#publish();
    if (active) this.#clearAutoStop();
    else this.#armAutoStop();
  }

  setAutoStopMs(ms) {
    if (!Number.isFinite(ms) || (ms !== 0 && ms < 1000)) throw new Error('自動停止までの待ち時間は、0（止めない）か1秒以上にしてください');
    this.autoStopMs = ms;
    this.metrics.write('auto_stop_setting', { autoStopMs: ms });
    if (this.autoStopTimer) {
      this.#clearAutoStop();
      this.#armAutoStop();
    }
    this.#publish();
  }

  #clearAutoStop() {
    clearTimeout(this.autoStopTimer);
    this.autoStopTimer = null;
    this.autoStopDueAt = null;
  }

  #armAutoStop() {
    if (this.autoStopMs <= 0) return; // 自動停止なし（既定）
    if (this.autoStopTimer || this.config.ivsMode === 'always-live') return;
    // 配信が動いている（または動かそうとしている）ときだけ数える
    if (!(this.isLive() || this.obsActive || this.desired === 'on')) return;
    const armedAt = nowMs();
    this.autoStopDueAt = armedAt + this.autoStopMs;
    this.autoStopTimer = setTimeout(() => {
      this.autoStopTimer = null;
      this.autoStopDueAt = null;
      if (this.active) return;
      this.metrics.write('auto_stop', { armedAt, firedAt: nowMs(), autoStopMs: this.autoStopMs });
      this.cancelWait();
      this.#command('stop', 'auto');
      this.#publish();
    }, this.autoStopMs);
    this.#publish();
  }

  // ------------------------------------------------------------ 進行コンソールからの手動操作
  manual(action) {
    if (action === 'start') {
      this.#command('start', 'manual');
      if (!this.active) this.#armAutoStop();
    } else if (action === 'stop') {
      this.cancelWait();
      this.#clearAutoStop();
      this.#command('stop', 'manual');
    } else if (action === 'status') {
      this.#command('status', 'manual');
    }
    this.#publish();
  }

  // ------------------------------------------------------------ エージェントとの通信
  attachAgent(ws, name) {
    if (this.agent && this.agent !== ws) this.agent.close(4000, 'replaced');
    this.agent = ws;
    this.metrics.write('agent_connected', { name });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'agent_result') this.#onAgentResult(msg);
      else if (msg.type === 'agent_state') this.#setObsActive(msg.obsActive, 'agent_state', msg);
      else if (msg.type === 'agent_cameras') this.#setCameras(msg);
      else if (msg.type === 'time') ws.send(JSON.stringify({ type: 'time', t0: msg.t0, ts: nowMs() }));
    });
    ws.on('close', () => {
      if (this.agent !== ws) return;
      this.agent = null;
      this.cameras = []; this.camera = null; // 切れている間は、切り替えられない
      this.metrics.write('agent_disconnected', { name });
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        this.pending.delete(id);
      }
      this.#publish();
    });
    // 再接続したら、まず OBS の本当の状態を聞き、サーバーが望む状態と食い違っていれば合わせる（P1-3）
    this.#send('status', 'reconcile').then((res) => {
      if (!res?.ok) return;
      if (this.desired === 'off' && res.obsActive) this.#command('stop', 'reconcile');
      else if (this.desired === 'on' && !res.obsActive && (this.waiting || this.active)) this.#command('start', 'reconcile');
    });
    this.#publish();
  }

  // ------------------------------------------------------------ カメラの切り替え（報告書 92 章）
  #setCameras(msg) {
    const cameras = Array.isArray(msg.cameras) ? msg.cameras.filter((n) => typeof n === 'string').slice(0, 20) : [];
    const camera = typeof msg.current === 'string' ? msg.current : null;
    if (JSON.stringify([cameras, camera]) === JSON.stringify([this.cameras, this.camera])) return;
    this.cameras = cameras; this.camera = camera;
    this.metrics.write('camera_state', { cameras, camera });
    this.#publish();
  }

  /** 映すカメラを切り替える。配信は止めない。結果 { ok, error } を返す */
  async setCamera(name, cause = 'manual') {
    if (!this.cameras.includes(name)) return { ok: false, error: 'unknown_camera' };
    const res = await this.#send('camera', cause, { camera: name });
    if (res?.ok) { this.camera = name; this.#publish(); }
    return res;
  }

  #command(action, cause) {
    if (action === 'start') this.desired = 'on';
    if (action === 'stop') this.desired = 'off';
    return this.#send(action, cause);
  }

  #send(action, cause, args = {}) {
    const id = ++this.cmdId;
    const sentAt = nowMs();
    if (!this.agent || this.agent.readyState !== 1) {
      this.metrics.write('agent_cmd', { id, action, cause, sentAt, ok: false, error: 'agent_not_connected' });
      return Promise.resolve({ ok: false, error: 'agent_not_connected' });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.metrics.write('agent_cmd', { id, action, cause, sentAt, ok: false, error: 'timeout' });
        resolve({ ok: false, error: 'timeout' });
      }, this.config.agentCmdTimeoutMs);
      this.pending.set(id, { resolve, timer, action, cause, sentAt });
      this.agent.send(JSON.stringify({ type: 'agent_cmd', id, action, sentAt, ...args }));
    });
  }

  #onAgentResult(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    // エージェント側の時刻（指示を受けた・OBS に送った・OBS から返った）も一緒に残す（POC-AGT-005）
    this.metrics.write('agent_cmd', {
      id: msg.id, action: p.action, cause: p.cause, sentAt: p.sentAt, resultAt: nowMs(),
      ok: !!msg.ok, error: msg.error ?? null, obsActive: msg.obsActive ?? null, agent: msg.timings ?? null,
    });
    if (typeof msg.obsActive === 'boolean') this.#setObsActive(msg.obsActive, 'agent_result');
    p.resolve(msg);
  }

  #setObsActive(value, source, extra = {}) {
    if (typeof value !== 'boolean') return;
    if (this.obsActive !== value) {
      this.metrics.write('obs_state', { obsActive: value, source, agentAt: extra.at ?? null });
      this.obsActive = value;
      if (value && !this.active) this.idleSince = nowMs(); // 競りがないときに配信が始まった: そこから数える
      if (this.config.ivsMode === 'mock') this.#mockFollow(value);
      if (value && !this.active) this.#armAutoStop();
      this.#publish();
    }
  }

  // ------------------------------------------------------------ IVS の状態（POC-IVS-001・002）
  setLive(method, live, extra = {}) {
    if (this.live[method] === live) return;
    this.live[method] = live;
    this.metrics.write('ivs_state', { method, live, ...extra }); // 「LIVE になった」と判断した時刻を方法ごとに残す
    if (method === 'event' && live) this.eventLiveAt = nowMs();
    const now = this.isLive();
    if (now && !this.wasLive) this.#armSettle();
    if (!now && this.wasLive) this.#clearAutoStop();
    this.wasLive = now;
    this.#publish();
  }

  #mockFollow(obsActive) {
    clearTimeout(this.mockTimer);
    this.mockTimer = setTimeout(() => this.setLive('mock', obsActive), obsActive ? this.config.ivsMockDelayMs : 500);
  }

  /** (a) GetStream を1秒ごとに問い合わせる */
  async startPolling() {
    const { IvsClient, GetStreamCommand } = await import('@aws-sdk/client-ivs');
    const client = new IvsClient({ region: this.config.ivsRegion }); // 認証情報は環境（IAM・環境変数）から。コードには書かない
    const command = new GetStreamCommand({ channelArn: this.config.ivsChannelArn });
    let busy = false;
    this.pollTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      const askedAt = nowMs();
      try {
        const res = await client.send(command);
        const live = res.stream?.state === 'LIVE';
        this.#onPoll(live, { askedAt, health: res.stream?.health, viewerCount: res.stream?.viewerCount, startTime: res.stream?.startTime });
      } catch (err) {
        // 配信していないチャンネルでは ChannelNotBroadcasting が返る見込み【未検証: PoC で確かめる】
        if (err?.name === 'ChannelNotBroadcasting') this.#onPoll(false, { askedAt });
        else this.metrics.write('ivs_poll_error', { askedAt, name: err?.name, message: err?.message });
      } finally {
        busy = false;
      }
    }, this.config.ivsPollMs);
  }

  #onPoll(live, extra) {
    const was = this.live.poll;
    this.setLive('poll', live, extra);
    // 問い合わせの結果を「今の状態」の正とする。配信が終わったのにイベントが届かなかった場合に備えて、イベント側も下げる。
    if (!live && this.live.event && (was || nowMs() - this.eventLiveAt > 15000)) {
      this.setLive('event', false, { cause: 'poll-says-offline' });
    }
  }

  /** (b) EventBridge のイベント（API destination 経由の POST）を受け取る */
  onEventBridge(event) {
    const receivedAt = nowMs();
    const name = event?.detail?.event_name;
    const arnOk = !this.config.ivsChannelArn || (event?.resources ?? []).includes(this.config.ivsChannelArn);
    this.metrics.write('ivs_event', {
      receivedAt, detailType: event?.['detail-type'], eventName: name, eventTime: event?.time, arnOk,
    });
    if (!arnOk || event?.['detail-type'] !== 'IVS Stream State Change') return;
    if (name === 'Stream Start') this.setLive('event', true, { eventTime: event.time, receivedAt });
    else if (name === 'Stream End') this.setLive('event', false, { eventTime: event.time, receivedAt });
  }

  stop() {
    clearInterval(this.pollTimer);
    clearTimeout(this.mockTimer);
    this.cancelWait();
    this.#clearAutoStop();
    for (const p of this.pending.values()) clearTimeout(p.timer);
  }
}
