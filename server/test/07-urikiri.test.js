// 「うりきり」: 最低落札額（全員に公開）に届いているか。落札の条件は「権利」と「うりきり」の両方。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, startServer, connectAll, createLot, lotLog, cleanup } from './helpers.js';

let ctx, srv, A, m;
before(async () => {
  ctx = makeEnv();
  srv = await startServer(ctx);
  ({ auctioneer: A, members: m } = await connectAll(srv, ctx, 3));
});
after(async () => { await srv.stop(); cleanup(ctx); });

test('最低落札額は全員に見え、届いたときに「うりきり」になる。届いて締めれば落札', async () => {
  // ロットの追加は全員に知らせる。会員の接続に届くのを待ってから確かめる（進行役への応答とは別の接続なので、順序は保証されない）
  const seen = m[0].waitFor((x) => x.type === 'lot' && x.lot.reservePrice === 11000);
  const lot = await createLot(A, 9500, null, 'テスト品', 11000);
  await seen;
  // 会員の画面にも、最低落札額の金額そのものが届いている（隠さない）
  assert.equal(m[0].lots.get(lot.id).reservePrice, 11000);
  assert.equal(m[0].lots.get(lot.id).urikiri, false);
  await A.cmd('start', { lotId: lot.id });

  const p1 = m[2].waitFor((x) => x.type === 'price' && x.amount === 9500);
  assert.equal((await m[0].bid(lot.id, 9500)).accepted, true);
  assert.equal((await p1).urikiri, false); // 権利はあるが、まだ売れる価格ではない
  await m[1].bid(lot.id, 10000);
  const p3 = m[2].waitFor((x) => x.type === 'price' && x.amount === 11000);
  assert.equal((await m[0].bid(lot.id, 11000)).accepted, true);
  assert.equal((await p3).urikiri, true); // 最低落札額ちょうどで届く

  const res = await A.cmd('close', { lotId: lot.id });
  assert.deepEqual([res.status, res.reason, res.amount, res.paddle], ['sold', null, 11000, m[0].paddle]);
});

test('入札があっても、最低落札額に届かないまま締めると流札になる', async () => {
  const lot = await createLot(A, 9500, null, 'テスト品', 12000);
  await A.cmd('start', { lotId: lot.id });
  assert.equal((await m[0].bid(lot.id, 9500)).accepted, true);
  assert.equal((await m[1].bid(lot.id, 10000)).accepted, true);
  const got = m[2].waitFor((x) => x.type === 'result' && x.lotId === lot.id);
  const res = await A.cmd('close', { lotId: lot.id });
  assert.deepEqual([res.status, res.reason], ['unsold', 'reserve_not_met']);
  const shown = await got;
  assert.deepEqual([shown.status, shown.reason, shown.amount], ['unsold', 'reserve_not_met', 10000]);
  const log = await lotLog(A, lot.id);
  assert.equal(log.lot.status, 'unsold');
  assert.equal(log.events.find((e) => e.type === 'finalized').data.winnerBidSeq, null);
  assert.equal(log.bids.filter((b) => b.result === 'ACCEPTED').length, 2); // 入札の記録は残る
  assert.equal((await m[2].bid(lot.id, 11000)).code, 'AFTER_CLOSE');
});

test('最低落札額のないロットは、いつでも「うりきり」。設定の誤りは拒否する', async () => {
  const lot = await createLot(A, 9500);
  assert.deepEqual([lot.reservePrice, lot.urikiri], [null, true]);
  const same = await createLot(A, 9500, null, 'テスト品', 9500); // 開始価格と同じなら、設定なしと同じ
  assert.deepEqual([same.reservePrice, same.urikiri], [null, true]);
  for (const bad of [9000, 10500, 1.5]) {
    const r = await A.cmd('create_lot', { title: 'x', startPrice: 9500, reservePrice: bad });
    assert.equal(r.ok, false, String(bad));
    assert.ok(r.message);
  }
});

test('締めの記録の直後に落ちても、復旧時に同じ条件で判定する（届いていなければ流札）', async () => {
  const lot = await createLot(A, 9500, null, 'テスト品', 12000);
  await A.cmd('start', { lotId: lot.id });
  await m[0].bid(lot.id, 9500);
  await A.cmd('crash', { point: 'after_close_record' });
  A.cmd('close', { lotId: lot.id }).catch(() => {});
  await srv.exited;
  srv = await startServer(ctx);
  ({ auctioneer: A, members: m } = await connectAll(srv, ctx, 3));
  const log = await lotLog(A, lot.id);
  assert.equal(log.lot.status, 'unsold');
  assert.equal(log.events.find((e) => e.type === 'finalized').data.reason, 'reserve_not_met');
});
