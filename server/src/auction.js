// 入札と締めの処理（POC-SRV-001〜005、本仕様 FR-BID-003・004、FR-CLS-001〜005、8.6）
//
// 順番の決め方:
//   1. 入札も「締め」も、サーバーが受け取った瞬間に、受付時刻と受付連番（全体で1本の連番）を振る。
//   2. ロットごとに1本の処理の列に入れ、受付連番の順に1件ずつ処理する。
//   3. 処理は同期（データベースへの書き込みを含む）なので、1件の途中に別の1件が割り込まない。
import { nowMs } from './clock.js';
import { minimumBid, minimumAllowed, validateTable } from './ladder.js';

const MAX_AMOUNT = 1e10; // 金額の上限（開始価格の上限と同じ）
/** 1回の入札で入れられる、いちばん高い額（min = 入札できる最も低い額） */
export const maxAllowed = (min) => Math.min(MAX_AMOUNT, Math.max(min * 2, min + 100000));

export const TERMINAL = new Set(['sold', 'unsold', 'not_held']);

/**
 * 「うりきり」: この価格で締めれば売れる状態か。
 * 最低落札額（出品者が決める。参加者には金額を見せない）がないロットは、いつでも売れる。あるロットは、現在価格がその額以上になったとき。
 */
export function reserveMet(reservePrice, currentPrice) {
  if (reservePrice === null || reservePrice === undefined) return true;
  return currentPrice !== null && currentPrice !== undefined && currentPrice >= reservePrice;
}
/**
 * 「うりきり」のランプ（発注者の決定。報告書 89 章）: オークショニアが「うりきり」を押したか、
 * 最低落札額が入っていて、いまの価格がそこに届いているとき。最低落札額の入力がない品は、押すまで点かない
 */
export function urikiriOn(lot, currentPrice = lot?.current_price ?? null) {
  if (!lot) return false;
  if (lot.urikiri_on) return true;
  return lot.reserve_price !== null && lot.reserve_price !== undefined && currentPrice !== null && currentPrice !== undefined && currentPrice >= lot.reserve_price;
}

export class Auction {
  /**
   * @param {object} deps
   * @param {ReturnType<import('./db.js').openDb>} deps.store
   * @param {object} deps.config
   * @param {{write: Function}} deps.metrics
   * @param {(msg: object) => number} deps.broadcast 全端末へ送り、送り出した時刻を返す
   * @param {import('./stream.js').StreamControl} deps.stream
   * @param {(point: string) => void} [deps.crashPoint] 障害の模擬用（本番では何もしない）
   * @param {() => (number|null)} [deps.eventId] いまの開催の番号
   * @param {Function} [deps.bidGate] 入札を受け付けてよいか（会員・開催の決まり）
   * @param {Function} [deps.lotGate] 競りを始めてよいか
   */
  constructor({ store, config, metrics, broadcast, stream, crashPoint = () => {}, eventId = () => null, bidGate = () => null, lotGate = () => null }) {
    validateTable(config.incrementTable);
    this.store = store;
    this.config = config;
    this.metrics = metrics;
    this.broadcast = broadcast;
    this.stream = stream;
    this.crashPoint = crashPoint;
    this.eventId = eventId;   // いまの開催（なければ null）
    this.lotGate = lotGate;   // 品の登録・開始を断る理由（本日の開催が終了したあと など。なければ null）
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
      action: msg.action, reason: msg.reason ?? '', reqId: msg.reqId ?? null, bidSeq: Number(msg.bidSeq), amount: msg.amount,
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
    // 参加の停止（FR-AUTH-009）。参加手続き（NOT_JOINED）は、接続のときに確かめる。個人の上限額（OVER_LIMIT）は持たない（発注者の決定）
    const blocked = this.bidGate(item.member, item);
    if (blocked) return blocked;
    if (lot.highest_member_id === item.member.id) return 'ALREADY_HIGHEST';
    // 開始価格以上なら、1円単位で入札できる（発注者の決定）。入札があれば、現在価格より高い額だけ。価格の段には合わせなくてよい
    const min = minimumAllowed(lot.start_price, lot.current_price);
    if (item.amount < min) return 'BELOW_MINIMUM';
    // 上限: 1人の入札で、競りを止められないようにする（けた外れの額を入れると、ほかの人が入札できなくなる）。
    // 絶対の上限は、開始価格と同じ 100億円。1回の入札で上げられるのは、「入札できる最も低い額の2倍」か「＋10万円」の、大きいほうまで
    // （10倍だと、組んだ2人が交互に入れて、1秒たらずで上限まで上げられた。2倍でも、組めば上げられるが、進行役が気づいて「中断」できる速さになる）
    if (item.amount > MAX_AMOUNT || item.amount > maxAllowed(min)) return 'TOO_HIGH';
    return 'ACCEPTED';
  }

  #processBid(item) {
    const { q, tx } = this.store;
    const lot = q.lot.get(item.lotId);
    const result = Number.isSafeInteger(item.amount) ? this.#judgeBid(lot, item) : 'OFF_LADDER';
    const accepted = result === 'ACCEPTED';

    // 金額が整数でない入札（壊れた端末・わざとの送信）は、記録にも入れずに断る（数でない値は、保存できない）
    if (lot && Number.isSafeInteger(item.amount)) {
      // 受理も拒否も記録する。この書き込み（fsync つき）が終わるまで、端末には何も返さない（NFR-REL-001）
      tx(() => {
        q.insertBid.run(item.seq, item.lotId, item.member.id, item.amount, item.receivedAt, result, item.proxyBy);
        if (accepted) q.setCurrentBid.run(item.seq, item.receivedAt, item.lotId);
      });
    }
    const processedAt = nowMs();

    const currentPrice = accepted ? item.amount : lot?.current_price ?? null;
    // minBid: 次の入札額の目安（価格の段）。minAllowed: 入札できる最も低い額（1円単位）
    const minBid = lot
      ? minimumBid(lot.start_price, currentPrice, this.config.incrementTable, lot.unit_override)
      : null;
    const minAllowed = lot ? minimumAllowed(lot.start_price, currentPrice) : null;
    item.reply({
      type: 'bid_result', reqId: item.reqId, lotId: item.lotId, seq: item.seq, accepted,
      code: accepted ? null : result, amount: item.amount, currentPrice, minBid, minAllowed,
      urikiri: lot ? urikiriOn(lot, currentPrice) : null,
      receivedAt: item.receivedAt, sentAt: processedAt,
    });
    const repliedAt = nowMs();

    let broadcastAt = null;
    if (accepted) {
      broadcastAt = this.broadcast({
        type: 'price', lotId: item.lotId, seq: item.seq, amount: item.amount, paddle: item.member.paddle_no, proxy: item.proxyBy ? 1 : 0,
        receivedAt: item.receivedAt, currentPrice, minBid, minAllowed, urikiri: urikiriOn(lot, currentPrice),
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
    let lot = q.lot.get(item.lotId); // 開始価格をいっしょに決めて始めるときは、読み直す
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
        { const why = this.lotGate(); if (why) return fail(why); }
        if (this.eventId() !== null && lot.event_id !== this.eventId()) return fail('この品は、いまの開催の品ではありません');
        if (q.busyLot.get(lot.id, lot.event_id)) return fail('進行中の品がほかにあります（同時に1つまで）');
        // 開始価格をいっしょに送ってきたら、先に開始価格を決めてから始める（1つの操作で。オークショニアの「開始価格を入力 → 競りを開始」）
        if (item.amount !== undefined && item.amount !== null && item.amount !== '') {
          const amount = Number(item.amount);
          if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1e10) return fail('開始価格を、1円以上の整数で入れてください');
          const reserve = lot.reserve_price // 最低落札額は、開始価格を変えても、そのまま（なくすと、ランプが点かなくなる。報告書 89 章）;
          this.store.tx(() => {
            q.setStartPrice.run(amount, reserve, item.receivedAt, lot.id);
            q.insertEvent.run(this.nextSeq(), lot.id, 'set_start', item.receivedAt, item.actor.name, JSON.stringify({ from: lot.start_pending ? null : lot.start_price, to: amount, withStart: true }));
          });
          lot = q.lot.get(lot.id);
        } else if (lot.start_pending) return fail('開始価格が決まっていません。開始価格を入れてから始めてください');
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
      // ---- オークショニアの操作（発注者の指示。報告書 73 章）
      case 'set_start': {
        // 開始価格の設定: まだ入札のない品だけ（入札があると、価格の基準が変わってしまう）
        if (!['waiting', 'preparing', 'preparing_warn', 'open', 'suspended'].includes(s)) return fail(`「${stateName}」の品は、開始価格を変えられません`);
        if (lot.current_bid_seq) return fail('入札があるので、開始価格は変えられません');
        const amount = Number(item.amount);
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1e10) return fail('開始価格を、1円以上の整数で入れてください');
        if (amount === lot.start_price && !lot.start_pending) return fail('いまの開始価格と同じです');
        // 最低落札額が新しい開始価格以下になるなら、最低落札額はなくなる（最初の入札で必ず届くため）
        const reserve = lot.reserve_price // 最低落札額は、開始価格を変えても、そのまま（なくすと、ランプが点かなくなる。報告書 89 章）;
        this.store.tx(() => {
          q.setStartPrice.run(amount, reserve, item.receivedAt, lot.id);
          q.insertEvent.run(item.seq, lot.id, 'set_start', item.receivedAt, item.actor.name, JSON.stringify({ from: lot.start_pending ? null : lot.start_price, to: amount, reserveCleared: lot.reserve_price !== null && reserve === null }));
        });
        this.broadcast({ type: 'lot', lot: this.lotView(lot.id), reason: null });
        extra = { startPrice: amount };
        break;
      }
      case 'urikiri': {
        // うりきり: いまの最高入札者（これからの最高入札者）に必ず売ると宣言し、ランプを点ける。取り消せない
        if (!['waiting', 'preparing', 'preparing_warn', 'open', 'suspended'].includes(s)) return fail(`「${stateName}」の品は、うりきりにできません`);
        if (urikiriOn(lot)) return fail('すでに、うりきりです');
        this.store.tx(() => {
          q.setUrikiri.run(item.receivedAt, lot.id);
          q.insertEvent.run(item.seq, lot.id, 'urikiri', item.receivedAt, item.actor.name, JSON.stringify({ reservePrice: lot.reserve_price, currentPrice: lot.current_price }));
        });
        this.broadcast({ type: 'lot', lot: this.lotView(lot.id), reason: null });
        break;
      }
      case 'pass': {
        // 流札: 売らずに、この品を終える。うりきりのランプが点いている品（うりきりを押した・最低落札額に届いた）は、流札にできない（報告書 79・89 章）。
        // 締めれば、入札があれば落札、なければ流札になる
        if (s !== 'open' && s !== 'suspended') return fail(`「${stateName}」の品は、流札にできません`);
        if (urikiriOn(lot)) return fail(`うりきりのため、流札にできません（締めると${lot.current_bid_seq ? '落札' : '流札'}になります）`);
        q.insertEvent.run(item.seq, lot.id, 'close', item.receivedAt, item.actor.name, JSON.stringify({ pass: true }));
        extra = this.#finalize(lot, item.seq, item.actor.name, { passed: true }, item);
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
    // 落札の条件: 受理された有効な入札があり（＝最高入札者に「権利」がある）、かつ「うりきり」のランプが点いている
    const met = urikiriOn(fresh);
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
      startPrice: lot.start_pending ? null : lot.start_price, // まだ決まっていなければ null（品名だけ登録した品）
      startPending: !!lot.start_pending,
      unit: lot.unit_override ?? null, // この品だけの入札単位（なければ、共通の表を使う）。端末が、入力された金額を確かめるのに使う
      currentPrice: lot.current_price ?? null, // 入札がなければ null（画面には開始価格を出す）
      minBid: lot.start_pending ? null : minimumBid(lot.start_price, lot.current_price, this.config.incrementTable, lot.unit_override), // 次の入札額の目安（価格の段）
      minAllowed: lot.start_pending ? null : minimumAllowed(lot.start_price, lot.current_price),                                       // 入札できる最も低い額（1円単位）
      highestPaddle: lot.highest_paddle ?? null,
      // 最低落札額。進行役だけに送る。会員の端末には金額を送らない（index.js の forMember で必ず落とす）
      reservePrice: lot.reserve_price ?? null,
      urikiri: urikiriOn(lot),
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
    return this.store.q.activeLotsOf.all(this.eventId()).length > 0;
  }
  /**
   * 終了の操作を忘れた開催を、管理画面から終える（本番運用の評価 A5）: その開催の、待機の品と、進行中のまま残った品を、すべて未実施にする。
   * 進行中のまま残った品（中断など）は、落札にしない（だれが落札か、進行役が確かめていないため）
   */
  closeOutEvent(eventId, actor) {
    const ids = this.store.q.openLotsOf.all(eventId).map((r) => r.id);
    for (const id of ids) this.#transition(this.store.q.lot.get(id), 'not_held', actor, { reason: '開催終了（管理画面）' }, this.nextSeq());
    return ids.length;
  }

  createLot({ title, startPrice, unitOverride = null, reservePrice = null }) {
    { const why = this.lotGate(); if (why) throw new Error(why); }
    // 開始価格は、空でもよい（品名だけ登録し、オークショニアが開始のときに決める。発注者の指示。報告書 76 章）。そのあいだは仮に 1 を入れておく
    const pending = startPrice === null || startPrice === undefined || startPrice === '' || startPrice === 0;
    const start = pending ? 1 : Number(startPrice);
    if (!Number.isSafeInteger(start) || start <= 0) throw new Error('開始価格は1円以上の整数にしてください');
    const reserve = reservePrice === null || reservePrice === undefined || reservePrice === '' ? null : Number(reservePrice);
    if (reserve !== null) {
      if (!Number.isSafeInteger(reserve) || reserve < start) throw new Error('最低落札額は、開始価格以上の整数にしてください');
      // 開始価格と同じ最低落札額は、そのまま持つ（最初の入札で届き、ランプが点く。報告書 89 章）
    }
    if (!String(title ?? '').trim()) throw new Error('品名を入力してください');
    if (String(title).trim().length > 100) throw new Error('品名は、100文字以内にしてください');
    const info = this.store.q.insertLot.run({ event: this.eventId(), title: String(title).trim(), start, unit: unitOverride, reserve, at: nowMs(), pending: pending ? 1 : 0 });
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
