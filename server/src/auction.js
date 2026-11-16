// 入札と締めの処理（POC-SRV-001〜005、本仕様 FR-BID-003・004、FR-CLS-001〜005、8.6）
//
// 順番の決め方:
//   1. 入札も「締め」も、サーバーが受け取った瞬間に、受付時刻と受付連番（全体で1本の連番）を振る。
//   2. ロットごとに1本の処理の列に入れ、受付連番の順に1件ずつ処理する。
//   3. 処理は同期（データベースへの書き込みを含む）なので、1件の途中に別の1件が割り込まない。
import { nowMs } from './clock.js';
import { minimumBid, isOnLadder, validateTable } from './ladder.js';

export const TERMINAL = new Set(['sold', 'unsold', 'not_held']);

/**
 * 「うりきり」: この価格で締めれば売れる状態か。
 * 最低落札額（出品者が決める。参加者には金額を見せない）がないロットは、いつでも売れる。あるロットは、現在価格がその額以上になったとき。
 */
export function reserveMet(reservePrice, currentPrice) {
  if (reservePrice === null || reservePrice === undefined) return true;
  return currentPrice !== null && currentPrice !== undefined && currentPrice >= reservePrice;
}

export class Auction {
  /**
   * @param {object} deps
   * @param {ReturnType<import('./db.js').openDb>} deps.store
   * @param {object} deps.config
   * @param {{write: Function}} deps.metrics
   * @param {(msg: object) => number} deps.broadcast 全端末へ送り、送り出した時刻を返す
   * @param {import('./stream.js').StreamControl} deps.stream
   * @param {(point: string) => void} deps.crashPoint 障害の模擬用（本番では何もしない）
   */
  constructor({ store, config, metrics, broadcast, stream, crashPoint = () => {}, eventId = () => null, bidGate = () => null }) {
    validateTable(config.incrementTable);
    this.store = store;
    this.config = config;
    this.metrics = metrics;
    this.broadcast = broadcast;
    this.stream = stream;
    this.crashPoint = crashPoint;
    this.eventId = eventId;   // いまの開催（なければ null）
    this.bidGate = bidGate;   // 入札してよい参加者か（だめなら理由コードを返す）
    this.queues = new Map(); // lotId -> 処理待ちの出来事
    this.draining = new Set();
    this.seq = store.q.maxSeq.get().s ?? 0;

    stream.on('ready', () => this.#onStreamReady());
    stream.on('timeout', () => this.#onStreamTimeout());
  }

  nextSeq() {
    return ++this.seq;
  }

  // ---------------------------------------------------------------- 起動時の復旧（FR-CLS-005、8.6）
  recover() {
    const { q } = this.store;
    const report = [];
    for (const { id, status } of q.activeLots.all()) {
      const lot = q.lot.get(id);
      if (status === 'preparing' || status === 'preparing_warn') {
        // 入札はまだ受け付けていないので、配信準備中に入る前の状態に戻す（待機。再開の途中なら中断）
        const to = lot.prep_from === 'suspended' ? 'suspended' : 'waiting';
        this.#transition(lot, to, 'system', { cause: 'recovery' });
        report.push({ lotId: id, from: status, to });
      } else if (status === 'open') {
        const last = q.lastEvent.get(id);
        if (last && last.type === 'close') {
          // 「締め」が記録されていた: 記録済みの入札で落札か流札を確定する（中断にしない）
          const res = this.#finalize(lot, last.seq, 'system', { cause: 'recovery' });
          report.push({ lotId: id, from: status, to: res.status });
        } else {
          this.#transition(lot, 'suspended', 'system', { cause: 'recovery' });
          report.push({ lotId: id, from: status, to: 'suspended' });
        }
      }
    }
    this.metrics.write('recovery', { report });
    this.#syncStreamActivity();
    return report;
  }

  // ---------------------------------------------------------------- 受付（連番を振って列に入れる）
  /** 入札を受け付ける。reply は入札した端末だけに結果を返す関数。 */
  receiveBid(member, msg, reply, { proxyBy = null } = {}) {
    const receivedAt = nowMs();
    const seq = this.nextSeq();
    const lotId = Number(msg.lotId);
    const amount = Number(msg.amount);
    this.#enqueue(lotId, {
      kind: 'bid', seq, receivedAt, lotId, amount, member, reply,
      proxyBy, // 代理入札なら、操作したスタッフの名前（FR-CON-005）。受理の条件は、本人の入札と同じ
      reqId: msg.reqId ?? null,
      clientSentAt: msg.clientSentAt ?? null, // 端末の時計のまま
      clientSentAtCorrected: msg.clientSentAtCorrected ?? null, // サーバーとの時刻の差で補正した値
    });
  }

  /** 進行役の操作を受け付ける。締めも他の操作も、入札と同じ列に入れる（FR-CLS-001）。 */
  receiveCommand(actor, msg, reply) {
    const receivedAt = nowMs();
    const seq = this.nextSeq();
    const lotId = Number(msg.lotId);
    this.#enqueue(lotId, {
      kind: 'cmd', seq, receivedAt, lotId, actor, reply,
      action: msg.action, reason: msg.reason ?? '', reqId: msg.reqId ?? null, bidSeq: Number(msg.bidSeq),
      clientSentAt: msg.clientSentAt ?? null, clientSentAtCorrected: msg.clientSentAtCorrected ?? null,
    });
  }

  #enqueue(lotId, item) {
    let queue = this.queues.get(lotId);
    if (!queue) this.queues.set(lotId, (queue = []));
    queue.push(item);
    if (this.draining.has(lotId)) return; // 処理中に届いたものは、今の処理の後ろに並ぶ
    this.draining.add(lotId);
    try {
      while (queue.length) {
        const next = queue.shift();
        if (next.kind === 'bid') this.#processBid(next);
        else this.#processCommand(next);
      }
    } finally {
      this.draining.delete(lotId);
      if (!queue.length) this.queues.delete(lotId);
    }
  }

  // ---------------------------------------------------------------- 入札の処理（FR-BID-003）
  #judgeBid(lot, item) {
    if (!lot) return 'LOT_NOT_OPEN';
    if (lot.status === 'sold' || lot.status === 'unsold') return 'AFTER_CLOSE'; // 締めの後に処理された（FR-CLS-002）
    if (lot.status !== 'open') return 'LOT_NOT_OPEN';
    // 参加の停止（FR-AUTH-009）。参加手続き（NOT_JOINED）は、接続のときに確かめる。上限額（OVER_LIMIT）は金額が未決（OQ-06）なので判定しない
    const blocked = this.bidGate(item.member);
    if (blocked) return blocked;
    if (lot.highest_member_id === item.member.id) return 'ALREADY_HIGHEST';
    const table = this.config.incrementTable;
    const min = minimumBid(lot.start_price, lot.current_price, table, lot.unit_override);
    if (!isOnLadder(item.amount, lot.start_price, table, lot.unit_override, min)) {
      return 'OFF_LADDER';
    }
    if (item.amount < min) return 'BELOW_MINIMUM';
    return 'ACCEPTED';
  }

  #processBid(item) {
    const { q, tx } = this.store;
    const lot = q.lot.get(item.lotId);
    const result = Number.isSafeInteger(item.amount) ? this.#judgeBid(lot, item) : 'OFF_LADDER';
    const accepted = result === 'ACCEPTED';

    if (lot) {
      // 受理も拒否も記録する。この書き込み（fsync つき）が終わるまで、端末には何も返さない（NFR-REL-001）
      tx(() => {
        q.insertBid.run(item.seq, item.lotId, item.member.id, item.amount, item.receivedAt, result, item.proxyBy);
        if (accepted) q.setCurrentBid.run(item.seq, item.receivedAt, item.lotId);
      });
    }
    const processedAt = nowMs();

    const currentPrice = accepted ? item.amount : lot?.current_price ?? null;
    const minBid = lot
      ? minimumBid(lot.start_price, currentPrice, this.config.incrementTable, lot.unit_override)
      : null;
    item.reply({
      type: 'bid_result', reqId: item.reqId, lotId: item.lotId, seq: item.seq, accepted,
      code: accepted ? null : result, amount: item.amount, currentPrice, minBid,
      urikiri: lot ? reserveMet(lot.reserve_price, currentPrice) : null,
      receivedAt: item.receivedAt, sentAt: processedAt,
    });
    const repliedAt = nowMs();

    let broadcastAt = null;
    if (accepted) {
      broadcastAt = this.broadcast({
        type: 'price', lotId: item.lotId, seq: item.seq, amount: item.amount, paddle: item.member.paddle_no, proxy: item.proxyBy ? 1 : 0,
        receivedAt: item.receivedAt, currentPrice, minBid, urikiri: reserveMet(lot.reserve_price, currentPrice),
      });
    }
    this.metrics.write('bid', {
      seq: item.seq, lotId: item.lotId, paddle: item.member.paddle_no, amount: item.amount, result,
      clientSentAt: item.clientSentAt, clientSentAtCorrected: item.clientSentAtCorrected,
      receivedAt: item.receivedAt, processedAt, repliedAt, broadcastAt,
    });
  }

  // ---------------------------------------------------------------- 進行役の操作（8.6 の状態遷移表）
  #processCommand(item) {
    const { q } = this.store;
    const lot = q.lot.get(item.lotId);
    const fail = (message) => {
      item.reply({ type: 'cmd_result', reqId: item.reqId, ok: false, action: item.action, lotId: item.lotId, message });
      this.metrics.write('cmd', { seq: item.seq, lotId: item.lotId, action: item.action, ok: false, message, receivedAt: item.receivedAt });
    };
    if (!lot) return fail('その No. の品がありません');
    const s = lot.status;
    const needReason = () => (item.reason.trim() ? null : '理由を入力してください');
    const stateName = STATE_LABEL[s];
    let extra = {};

    switch (item.action) {
      case 'start': {
        if (s !== 'waiting') return fail(`「${stateName}」の品は競りを開始できません`);
        if (q.busyLot.get(lot.id)) return fail('進行中の品がほかにあります（同時に1つまで）');
        this.#beginOrPrepare(lot, 'waiting', item.actor.name);
        break;
      }
      case 'close': {
        if (s !== 'open') return fail(`「${stateName}」の品は締められません`);
        this.crashPoint('before_close_record');
        // ① まず「締め」という出来事そのものを記録する（ここまで済めば、落ちても復旧時に確定できる）
        q.insertEvent.run(item.seq, lot.id, 'close', item.receivedAt, item.actor.name, '{}');
        this.crashPoint('after_close_record');
        // ② 記録済みの入札で、落札か流札を確定する
        extra = this.#finalize(lot, item.seq, item.actor.name, {}, item);
        break;
      }
      case 'suspend': {
        if (s !== 'open') return fail(`「${stateName}」の品は中断できません`);
        this.#transition(lot, 'suspended', item.actor.name, {}, item.seq);
        break;
      }
      case 'resume': {
        if (s !== 'suspended') return fail(`「${stateName}」の品は再開できません`);
        // 中断の間に配信が自動で止まっていたら、「競り開始」と同じ手順で映像が届くのを待つ（FR-STR-003）
        this.#beginOrPrepare(lot, 'suspended', item.actor.name);
        break;
      }
      case 'cancel': {
        if (s !== 'suspended') return fail(`「${stateName}」の品は取りやめできません（先に中断してください）`);
        const err = needReason();
        if (err) return fail(err);
        this.store.tx(() => {
          q.voidBids.run(item.reason, lot.id);
          q.clearCurrentBid.run(lot.id);
        });
        this.#transition(lot, 'waiting', item.actor.name, { reason: item.reason, voided: true }, item.seq);
        break;
      }
      case 'exclude': {
        if (s !== 'waiting') return fail(`「${stateName}」の品は除外できません`);
        const err = needReason();
        if (err) return fail(err);
        this.#transition(lot, 'not_held', item.actor.name, { reason: item.reason }, item.seq);
        break;
      }
      case 'start_without_video': {
        if (s !== 'preparing_warn') return fail('「映像なしで開始」は、配信準備中（警告）のときだけ選べます');
        this.stream.cancelWait();
        this.#transition(lot, 'open', item.actor.name, { noVideo: true }, item.seq, { noVideo: 1 });
        break;
      }
      case 'back_to_waiting': {
        if (s !== 'preparing' && s !== 'preparing_warn') return fail('「待機に戻す」は、配信準備中のときだけ選べます');
        this.stream.cancelWait();
        const to = lot.prep_from === 'suspended' ? 'suspended' : 'waiting';
        this.#transition(lot, to, item.actor.name, {}, item.seq);
        break;
      }
      case 'cancel_proxy': {
        // 代理入札の取り消し（FR-CON-006）: 締めの前で、その後に別の入札がまだない場合だけ
        if (s !== 'open' && s !== 'suspended') return fail(`「${stateName}」の品では、代理入札を取り消せません`);
        const bid = q.bid.get(item.bidSeq);
        if (!bid || bid.lot_id !== lot.id || !bid.proxy_by || !bid.valid || bid.result !== 'ACCEPTED') return fail('取り消せる代理入札が見つかりません');
        if (lot.current_bid_seq !== bid.seq) return fail('その後に別の入札があるため、取り消せません');
        const err = needReason();
        if (err) return fail(err);
        const prev = q.prevValidBid.get(lot.id, bid.seq);
        this.store.tx(() => {
          q.voidBid.run(item.reason, bid.seq);
          // 現在価格を、1つ前の有効な入札に戻す。なければ「入札なし」に戻す
          if (prev) q.setCurrentBid.run(prev.seq, item.receivedAt, lot.id); else q.clearCurrentBid.run(lot.id);
          q.insertEvent.run(item.seq, lot.id, 'proxy_cancel', item.receivedAt, item.actor.name, JSON.stringify({ bidSeq: bid.seq, reason: item.reason }));
        });
        // 全員の画面を更新する（1つ前の最高入札者に、権利表示が戻る）
        this.broadcast({ type: 'bid_void', lotId: lot.id, seq: bid.seq, lot: this.lotView(lot.id) });
        break;
      }
      default:
        return fail(`知らない操作です: ${item.action}`);
    }
    const doneAt = nowMs();
    item.reply({ type: 'cmd_result', reqId: item.reqId, ok: true, action: item.action, lotId: item.lotId, seq: item.seq, ...extra });
    this.metrics.write('cmd', {
      seq: item.seq, lotId: item.lotId, action: item.action, ok: true,
      clientSentAt: item.clientSentAt, clientSentAtCorrected: item.clientSentAtCorrected,
      receivedAt: item.receivedAt, doneAt,
    });
    this.#syncStreamActivity();
  }

  /** 配信が届いていれば受付中に、止まっていれば配信準備中にして、エージェントに開始を指示する */
  #beginOrPrepare(lot, from, actor) {
    if (this.stream.isLive()) {
      this.#transition(lot, 'open', actor, { from });
    } else {
      this.#transition(lot, 'preparing', actor, { from }, null, { prepFrom: from });
      this.stream.ensureStarted({ lotId: lot.id });
    }
  }

  #onStreamReady() {
    for (const { id, status } of this.store.q.activeLots.all()) {
      if (status === 'preparing' || status === 'preparing_warn') {
        this.#transition(this.store.q.lot.get(id), 'open', 'system', { cause: 'live+settle' });
      }
    }
    this.#syncStreamActivity();
  }

  #onStreamTimeout() {
    for (const { id, status } of this.store.q.activeLots.all()) {
      if (status === 'preparing') {
        this.#transition(this.store.q.lot.get(id), 'preparing_warn', 'system', { cause: 'live-timeout' }, null, { keepPrepFrom: true });
      }
    }
  }

  /** 状態を変え、出来事として記録し、全端末に知らせる */
  #transition(lot, to, actor, data = {}, seq = null, opts = {}) {
    const { q, tx } = this.store;
    const at = nowMs();
    const prepFrom = to === 'preparing' ? opts.prepFrom ?? 'waiting' : opts.keepPrepFrom ? lot.prep_from : null;
    const noVideo = to === 'open' ? opts.noVideo ?? (lot.status === 'suspended' ? lot.no_video : 0) : lot.no_video;
    tx(() => {
      q.setStatus.run(to, prepFrom, noVideo, at, lot.id);
      q.insertEvent.run(seq ?? this.nextSeq(), lot.id, 'state', at, actor, JSON.stringify({ from: lot.status, to, ...data }));
    });
    const sentAt = this.broadcast({ type: 'lot', lot: this.lotView(lot.id), reason: data.reason ?? null });
    this.metrics.write('lot_state', { lotId: lot.id, from: lot.status, to, actor, at, sentAt, ...data });
  }

  /** 落札・流札を確定する（FR-CLS-002）。item があれば、進行役の「締め」からの通常の確定。 */
  #finalize(lot, closeSeq, actor, data = {}, item = null) {
    const { q, tx } = this.store;
    const fresh = q.lot.get(lot.id);
    // 落札の条件: 受理された有効な入札があり（＝最高入札者に「権利」がある）、かつ最低落札額に届いている（＝「うりきり」）
    const met = reserveMet(fresh.reserve_price, fresh.current_price);
    const status = fresh.current_bid_seq && met ? 'sold' : 'unsold';
    const reason = status === 'unsold' ? (fresh.current_bid_seq ? 'reserve_not_met' : 'no_bids') : null;
    const at = nowMs();
    tx(() => {
      q.finalize.run(status, closeSeq, status === 'sold' ? fresh.current_bid_seq : null, at, lot.id);
      q.insertEvent.run(this.nextSeq(), lot.id, 'finalized', at, actor, JSON.stringify({
        status, reason, reservePrice: fresh.reserve_price, closeSeq, winnerBidSeq: status === 'sold' ? fresh.current_bid_seq : null,
        amount: fresh.current_price, paddle: fresh.highest_paddle, ...data,
      }));
    });
    const finalizedAt = nowMs();
    const result = {
      status, reason, closeSeq, paddle: fresh.highest_paddle ?? null, amount: fresh.current_price ?? null,
    };
    // 確定したら、すぐに全員へ結果を送る（FR-CLS-003）
    const sentAt = this.broadcast({
      type: 'result', lotId: lot.id, ...result, closeReceivedAt: item?.receivedAt ?? null, lot: this.lotView(lot.id),
    });
    this.metrics.write('close', {
      lotId: lot.id, closeSeq, ...result, recovered: !item,
      clientSentAt: item?.clientSentAt ?? null, clientSentAtCorrected: item?.clientSentAtCorrected ?? null,
      receivedAt: item?.receivedAt ?? null, finalizedAt, broadcastAt: sentAt,
    });
    return result;
  }

  /** 「受付中」「配信準備中」のロットがあるかを配信の制御に伝える（自動停止の判定。FR-STR-003） */
  #syncStreamActivity() {
    const active = this.store.q.activeLots.all().some((l) => l.status !== 'suspended');
    this.stream.setActive(active);
  }

  // ---------------------------------------------------------------- 画面用のデータ
  lotView(lotId) {
    const lot = this.store.q.lot.get(lotId);
    return lot ? this.#view(lot) : null;
  }

  #view(lot) {
    return {
      id: lot.id, lotNo: lot.lot_no, title: lot.title, status: lot.status, noVideo: !!lot.no_video,
      startPrice: lot.start_price,
      currentPrice: lot.current_price ?? null, // 入札がなければ null（画面には開始価格を出す）
      minBid: minimumBid(lot.start_price, lot.current_price, this.config.incrementTable, lot.unit_override),
      highestPaddle: lot.highest_paddle ?? null,
      // 最低落札額。進行役だけに送る。会員の端末には金額を送らない（index.js の forMember で必ず落とす）
      reservePrice: lot.reserve_price ?? null,
      urikiri: reserveMet(lot.reserve_price, lot.current_price),
      closeSeq: lot.close_seq ?? null,
    };
  }

  /** 最新の状態（再接続のときに取り直す。FR-UI-002）。入札の履歴は全件・受付順・全員に同じものを返す。 */
  snapshot() {
    const lots = this.store.q.lots.all(this.eventId()).map((l) => this.#view(l)); // いまの開催の品だけ
    const focus = lots.find((l) => !TERMINAL.has(l.status) && l.status !== 'waiting') ?? null;
    const last = focus ?? [...lots].reverse().find((l) => l.status === 'sold' || l.status === 'unsold') ?? null;
    return {
      lots,
      focusLotId: last?.id ?? null,
      history: last ? this.store.q.history.all(last.id) : [],
    };
  }

  /** 落札の一覧（進行コンソール用。受け取り方法・支払方法つき） */
  soldList() {
    return this.store.q.soldList.all(this.eventId());
  }

  /** 開催終了（FR-EVT-003）: 待機の品を、すべて未実施にする。進行中の品があるときは呼ばない */
  closeOutWaiting(actor) {
    const ids = this.store.q.waitingLots.all(this.eventId()).map((r) => r.id);
    for (const id of ids) this.#transition(this.store.q.lot.get(id), 'not_held', actor, { reason: '開催終了' }, this.nextSeq());
    return ids.length;
  }
  hasActiveLot() {
    return this.store.q.activeLots.all().length > 0;
  }

  createLot({ title, startPrice, unitOverride = null, reservePrice = null }) {
    const start = Number(startPrice);
    if (!Number.isSafeInteger(start) || start <= 0) throw new Error('開始価格は1円以上の整数にしてください');
    let reserve = reservePrice === null || reservePrice === undefined || reservePrice === '' ? null : Number(reservePrice);
    if (reserve !== null) {
      if (!Number.isSafeInteger(reserve) || reserve < start) throw new Error('最低落札額は、開始価格以上の整数にしてください');
      if (!isOnLadder(reserve, start, this.config.incrementTable, unitOverride)) throw new Error('最低落札額は、入札できる金額（価格の段）に合わせてください');
      if (reserve === start) reserve = null; // 開始価格と同じなら、最初の入札で必ず届くので、設定なしと同じ
    }
    const info = this.store.q.insertLot.run({ event: this.eventId(), title: String(title), start, unit: unitOverride, reserve, at: nowMs() });
    const lot = this.lotView(Number(info.lastInsertRowid));
    this.broadcast({ type: 'lot', lot });
    return lot;
  }

  lotLog(lotId) {
    return {
      lot: this.lotView(lotId),
      bids: this.store.q.allBids.all(lotId),
      events: this.store.q.events.all(lotId).map((e) => ({ ...e, data: JSON.parse(e.data) })),
    };
  }
}

export const STATE_LABEL = {
  waiting: '待機', preparing: '配信準備中', preparing_warn: '配信準備中（警告）', open: '受付中',
  suspended: '中断', sold: '落札', unsold: '流札', not_held: '未実施',
};
