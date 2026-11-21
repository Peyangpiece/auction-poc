// 「うりきり」: 最低落札額に届いているか。落札の条件は「権利」と「うりきり」の両方。
// 最低落札額の金額は、進行役にだけ送る。会員の端末には、どのメッセージでも届かない。
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

test('最低落札額の金額は会員に届かず、届いたときに「うりきり」だけが伝わる。届いて締めれば落札', async () => {
  // ロットの追加は全員に知らせる。会員の接続に届くのを待ってから確かめる（進行役への応答とは別の接続なので、順序は保証されない）
  // 会員に届くメッセージをすべて控えておき、最後に金額が1度も含まれていないことを確かめる
  const heard = [];
  const tap = (msg) => heard.push(JSON.stringify(msg));
  m[2].handlers.add(tap);
  const seen = m[0].waitFor((x) => x.type === 'lot' && x.lot.startPrice === 9500 && x.lot.urikiri === false);
  const lot = await createLot(A, 9500, null, 'テスト品', 11000);
  await seen;
  assert.equal(lot.reservePrice, 11000); // 進行役には金額が返る
  assert.equal('reservePrice' in m[0].lots.get(lot.id), false); // 会員の端末には、項目そのものが届かない
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

  // つなぎ直したとき・状態を取り直したときにも、金額は届かない
  m[2].send({ type: 'sync' });
  const snap = await m[2].waitFor((x) => x.type === 'snapshot');
  assert.ok(snap.lots.every((l) => !('reservePrice' in l)));
  m[2].handlers.delete(tap);
  assert.ok(heard.length >= 5);
  assert.ok(heard.every((t) => !t.includes('reservePrice')), '会員に届いたメッセージに、最低落札額の項目が含まれている');
  // 進行役の取り直しには含まれる
  A.send({ type: 'sync' });
  const staffSnap = await A.waitFor((x) => x.type === 'snapshot');
  assert.equal(staffSnap.lots.find((l) => l.id === lot.id).reservePrice, 11000);
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

test('最低落札額の入力がないロットは、オークショニアが「うりきり」を押すまでランプが点かない（発注者の決定。報告書 89 章）', async () => {
  const lot = await createLot(A, 9500, null, 'テスト品', null, { urikiri: false });
  assert.deepEqual([lot.reservePrice, lot.urikiri], [null, false], '入力がなければ、ランプは消えたまま');
  await A.cmd('start', { lotId: lot.id });
  const r1 = await m[0].bid(lot.id, 9500);
  assert.deepEqual([r1.accepted, r1.urikiri], [true, false], '入札があっても、押すまでは点かない');
  assert.equal((await A.cmd('urikiri', { lotId: lot.id })).ok, true);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(m[1].lots.get(lot.id).urikiri, true, '押すと、会員の画面のランプが点く');
  assert.equal((await A.cmd('urikiri', { lotId: lot.id })).message, 'すでに、うりきりです');
  assert.match((await A.cmd('pass', { lotId: lot.id })).message, /うりきりのため/, 'ランプが点いたら、流札にできない');
  assert.equal((await A.cmd('close', { lotId: lot.id })).status, 'sold', '押したあとに締めれば、落札');

  // 押さずに締めると、入札があっても流札（2つのランプがそろわない）
  const lot2 = await createLot(A, 9500, null, 'テスト品', null, { urikiri: false });
  await A.cmd('start', { lotId: lot2.id });
  assert.equal((await m[0].bid(lot2.id, 9500)).accepted, true);
  const closed = await A.cmd('close', { lotId: lot2.id });
  assert.equal(closed.status, 'unsold', '押さずに締めると、流札');
});

test('最低落札額が開始価格と同じなら、最初の入札でランプが点く。設定の誤りは拒否する', async () => {
  const same = await createLot(A, 9500, null, 'テスト品', 9500);
  assert.deepEqual([same.reservePrice, same.urikiri], [9500, false], '最低落札額は、そのまま持つ（入札の前は、まだ点かない）');
  await A.cmd('start', { lotId: same.id });
  assert.equal((await m[0].bid(same.id, 9500)).urikiri, true, '最初の入札で届いて、点く');
  await A.cmd('close', { lotId: same.id });
  const odd = await createLot(A, 9500, null, 'テスト品', 10501); // 1円単位で入札できるので、最低落札額も段に合わせなくてよい
  assert.equal(odd.reservePrice, 10501);
  for (const bad of [9000, 1.5]) {
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
