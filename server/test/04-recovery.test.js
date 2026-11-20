// P2-3・P2-5: 強制終了からの復旧（FR-CLS-005、NFR-REL-001・002、8.6）
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, startServer, connectAll, createLot, lotLog, cleanup, sleep } from './helpers.js';

async function setup(nMembers = 3) {
  const ctx = makeEnv();
  const srv = await startServer(ctx);
  const { auctioneer: A, members: m } = await connectAll(srv, ctx, nMembers);
  return { ctx, srv, A, m };
}

test('P2-3a 「締め」を記録した直後、確定を保存する前に強制終了 → 再起動で確定する（落札）', async () => {
  let { ctx, srv, A, m } = await setup();
  const lot = await createLot(A, 9500);
  await A.cmd('start', { lotId: lot.id });
  assert.equal((await m[0].bid(lot.id, 9500)).accepted, true);
  assert.equal((await m[1].bid(lot.id, 10000)).accepted, true);
  assert.equal((await A.cmd('crash', { point: 'after_close_record' })).ok, true);
  A.cmd('close', { lotId: lot.id }).catch(() => {}); // 応答は返らない（サーバーが落ちる）
  assert.equal((await srv.exited).signal, 'SIGKILL');

  srv = await startServer(ctx);
  ({ auctioneer: A, members: m } = await connectAll(srv, ctx, 3));
  const log = await lotLog(A, lot.id);
  assert.equal(log.lot.status, 'sold', '中断にならず、確定する（AC-FR-CLS-005-1）');
  assert.deepEqual([log.lot.currentPrice, log.lot.highestPaddle], [10000, m[1].paddle]);
  const fin = log.events.find((e) => e.type === 'finalized');
  assert.equal(fin.data.cause, 'recovery');
  assert.equal(fin.data.closeSeq, log.events.find((e) => e.type === 'close').seq);
  assert.equal((await m[2].bid(lot.id, 11000)).code, 'AFTER_CLOSE');
  await srv.stop(); cleanup(ctx);
});

test('P2-3a 同じ位置での強制終了（入札なし）→ 再起動で流札に確定する', async () => {
  let { ctx, srv, A } = await setup();
  const lot = await createLot(A, 9500);
  await A.cmd('start', { lotId: lot.id });
  await A.cmd('crash', { point: 'after_close_record' });
  A.cmd('close', { lotId: lot.id }).catch(() => {});
  await srv.exited;
  srv = await startServer(ctx);
  ({ auctioneer: A } = await connectAll(srv, ctx, 0));
  assert.equal((await lotLog(A, lot.id)).lot.status, 'unsold');
  await srv.stop(); cleanup(ctx);
});

test('P2-3b 「締め」を記録する前に強制終了 → 再起動で中断になり、再開して締められる', async () => {
  let { ctx, srv, A, m } = await setup();
  const lot = await createLot(A, 9500);
  await A.cmd('start', { lotId: lot.id });
  assert.equal((await m[0].bid(lot.id, 9500)).accepted, true);
  await A.cmd('crash', { point: 'before_close_record' });
  A.cmd('close', { lotId: lot.id }).catch(() => {});
  assert.equal((await srv.exited).signal, 'SIGKILL');

  srv = await startServer(ctx);
  ({ auctioneer: A, members: m } = await connectAll(srv, ctx, 3));
  const log = await lotLog(A, lot.id);
  assert.equal(log.lot.status, 'suspended');
  assert.equal(log.events.some((e) => e.type === 'close'), false, '「締め」は記録されていない');
  assert.deepEqual([log.lot.currentPrice, log.lot.highestPaddle], [9500, m[0].paddle]);
  assert.equal((await A.cmd('resume', { lotId: lot.id })).ok, true);
  assert.equal((await m[1].bid(lot.id, 10000)).accepted, true);
  const res = await A.cmd('close', { lotId: lot.id });
  assert.deepEqual([res.status, res.amount], ['sold', 10000]);
  await srv.stop(); cleanup(ctx);
});

test('P2-5 受付中に強制終了（kill -9）→ 中断になり、受理済みの入札がすべて残る', async () => {
  let { ctx, srv, A, m } = await setup();
  const lot = await createLot(A, 1000, 1000);
  await A.cmd('start', { lotId: lot.id });
  const accepted = [];
  for (let i = 0; i < 40; i++) {
    const r = await m[i % 3].bid(lot.id, 1000 + i * 1000);
    assert.equal(r.accepted, true);
    accepted.push(r.seq); // 「受理」と返ってきたものだけを数える
  }
  // 応答を待たずに送り続けている最中に落とす（返事が来なかった入札は、受理とも拒否とも約束していない）
  const inflight = [];
  for (let i = 40; i < 80; i++) inflight.push(m[i % 3].bid(lot.id, 1000 + i * 1000).then((r) => r.accepted && accepted.push(r.seq), () => {}));
  await sleep(2);
  await srv.kill9();
  await Promise.all(inflight);

  srv = await startServer(ctx);
  ({ auctioneer: A, members: m } = await connectAll(srv, ctx, 3));
  const log = await lotLog(A, lot.id);
  assert.equal(log.lot.status, 'suspended');
  const stored = new Set(log.bids.filter((b) => b.result === 'ACCEPTED' && b.valid === 1).map((b) => b.seq));
  for (const seq of accepted) assert.ok(stored.has(seq), `受理と返した入札 seq=${seq} が残っている`);
  assert.ok(accepted.length >= 40);
  // 現在価格は、残っている最高の入札と一致する
  const top = log.bids.filter((b) => b.result === 'ACCEPTED').at(-1);
  assert.equal(log.lot.currentPrice, top.amount);
  console.log(`# P2-5: 受理と返した ${accepted.length} 件がすべて残っていた（DB 上の受理 ${stored.size} 件）`);
  // 再開して続けられる。受付連番は、落ちる前の続きから振られる
  assert.equal((await A.cmd('resume', { lotId: lot.id })).ok, true);
  const next = m.find((c) => c.paddle !== log.lot.highestPaddle);
  const r = await next.bid(lot.id, log.lot.minBid);
  assert.equal(r.accepted, true);
  assert.ok(r.seq > Math.max(...stored));
  await srv.stop(); cleanup(ctx);
});
