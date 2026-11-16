// P2-1・P2-2: 同じ瞬間に届く入札と「締め」を、受付連番の順だけで処理できているか。
// 回数は環境変数 P2_ROUNDS で変えられる（既定は PoC 仕様書どおり 1,000 回）。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, startServer, connectAll, createLot, lotLog, cleanup } from './helpers.js';
import { minimumBid, isOnLadder } from '../src/ladder.js';

const ROUNDS = Number(process.env.P2_ROUNDS ?? 1000);
const TABLE = [{ lt: 10000, unit: 500 }, { unit: 1000 }];
let ctx, srv, A, m;
before(async () => {
  ctx = makeEnv();
  srv = await startServer(ctx);
  ({ auctioneer: A, members: m } = await connectAll(srv, ctx, 5));
});
after(async () => { await srv.stop(); cleanup(ctx); });

/** 記録された入札と締めを、仕様の規則だけで受付連番の順にたどり直し、サーバーの結果と突き合わせる */
function replay(log, startPrice, unit) {
  const close = log.events.find((e) => e.type === 'close');
  let price = null, highest = null, winner = null;
  const problems = [];
  for (const b of log.bids) {
    let expect;
    if (close && b.seq > close.seq) expect = 'AFTER_CLOSE';
    else if (highest === b.paddle) expect = 'ALREADY_HIGHEST';
    else {
      const min = minimumBid(startPrice, price, TABLE, unit);
      if (!isOnLadder(b.amount, startPrice, TABLE, unit)) expect = 'OFF_LADDER';
      else if (b.amount < min) expect = 'BELOW_MINIMUM';
      else { expect = 'ACCEPTED'; price = b.amount; highest = b.paddle; winner = b.seq; }
    }
    if (expect !== b.result) problems.push({ seq: b.seq, expect, got: b.result });
  }
  return { problems, price, highest, winner, closeSeq: close?.seq ?? null };
}

test(`P2-1 同じ最低入札額の入札を2つの端末から同時に送る（${ROUNDS} 回）`, { timeout: 600000 }, async () => {
  const lot = await createLot(A, 1000, 1000);
  await A.cmd('start', { lotId: lot.id });
  let highest = null;
  let firstSenderLost = 0;
  for (let i = 0; i < ROUNDS; i++) {
    // 現在の最高入札者ではない2人が、同じ最低入札額で同時に入札する
    const pair = m.filter((c) => c.paddle !== highest).sort(() => Math.random() - 0.5).slice(0, 2);
    const amount = 1000 + i * 1000;
    const [r0, r1] = await Promise.all(pair.map((c) => c.bid(lot.id, amount))); // 同じ tick で送り出す
    const win = r0.accepted ? r0 : r1;
    const lose = r0.accepted ? r1 : r0;
    assert.equal(win.accepted, true, `round ${i}: どちらかが受理される`);
    assert.equal(lose.accepted, false, `round ${i}: 両方が受理されてはならない`);
    assert.equal(lose.code, 'BELOW_MINIMUM', `round ${i}`);
    assert.ok(win.seq < lose.seq, `round ${i}: 受理されたのは受付連番が先の方`);
    assert.equal(lose.minBid, amount + 1000);
    if (r1.accepted) firstSenderLost++;
    highest = pair[r0.accepted ? 0 : 1].paddle;
  }
  const log = await lotLog(A, lot.id);
  assert.equal(log.bids.length, ROUNDS * 2);
  assert.deepEqual(replay(log, 1000, 1000).problems, []);
  assert.equal(log.lot.currentPrice, ROUNDS * 1000);
  assert.equal((await A.cmd('close', { lotId: lot.id })).status, 'sold');
  console.log(`# P2-1: ${ROUNDS} 回すべて期待どおり（後から送り出した側が先に受け付けられた回: ${firstSenderLost}）`);
});

test(`P2-2 「締め」と入札を複数の端末から同時に送る（${ROUNDS} 回）`, { timeout: 900000 }, async () => {
  const stat = { before: 0, after: 0, both: 0, sold: 0, unsold: 0 };
  for (let i = 0; i < ROUNDS; i++) {
    const lot = await createLot(A, 9500);
    assert.equal((await A.cmd('start', { lotId: lot.id })).ok, true);
    if (i % 2) await m[4].bid(lot.id, 9500); // 半分の回は、締めの前から入札がある状態にする
    const ladder = [9500, 10000, 11000, 12000];
    // 入札4件と「締め」を、順番をまぜて同じ tick で送り出す
    const jobs = [
      ...m.slice(0, 4).map((c, k) => () => c.bid(lot.id, ladder[(k + (i % 2)) % 4])),
      () => A.cmd('close', { lotId: lot.id }),
    ].sort(() => Math.random() - 0.5);
    const results = await Promise.all(jobs.map((j) => j()));
    const closeRes = results.find((r) => r.type === 'cmd_result');
    assert.equal(closeRes.ok, true);

    const log = await lotLog(A, lot.id);
    const rp = replay(log, 9500, null);
    assert.deepEqual(rp.problems, [], `round ${i}: 結果が受付連番の順と一致する`);
    assert.equal(rp.closeSeq, closeRes.seq);
    assert.equal(log.lot.closeSeq, closeRes.seq);
    // 「締め」より前の入札はすべて処理され、後の入札はすべて AFTER_CLOSE（AC-FR-CLS-002-1）
    const before = log.bids.filter((b) => b.seq < rp.closeSeq);
    const afterBids = log.bids.filter((b) => b.seq > rp.closeSeq);
    assert.ok(before.every((b) => b.result !== 'AFTER_CLOSE'));
    assert.ok(afterBids.every((b) => b.result === 'AFTER_CLOSE'));
    // 落札・流札は、締めより前に受理された入札だけで決まる
    assert.equal(log.lot.status, rp.winner ? 'sold' : 'unsold');
    assert.equal(closeRes.amount, rp.price);
    assert.equal(closeRes.paddle, rp.highest);
    const fin = log.events.find((e) => e.type === 'finalized');
    assert.equal(fin.data.winnerBidSeq, rp.winner);

    const nb = before.length - (i % 2), na = afterBids.length;
    stat.before += nb; stat.after += na; if (nb && na) stat.both++;
    stat[log.lot.status]++;
  }
  console.log(`# P2-2: ${ROUNDS} 回すべて期待どおり ${JSON.stringify(stat)}`);
  assert.ok(stat.before > 0 && stat.after > 0, '締めの前後の両方に入札が分かれた回がないと、検証になっていない');
});
