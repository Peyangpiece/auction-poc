// オークショニアの操作（発注者の指示。報告書 73 章）: 開始値の設定・うりきり・締め・流札
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, startServer, connectAll, createLot, cleanup, sleep } from './helpers.js';

let ctx, srv, A, m;
before(async () => {
  ctx = makeEnv();
  srv = await startServer(ctx);
  ({ auctioneer: A, members: m } = await connectAll(srv, ctx, 2));
});
after(async () => { await srv.stop(); cleanup(ctx); });

test('開始値は、入札の前だけ変えられる。最低落札額以上にすると、最低落札額はなくなる', async () => {
  const lot = await createLot(A, 10000, null, '柱時計', 15000);
  let r = await A.cmd('set_start', { lotId: lot.id, amount: 8000 });
  assert.deepEqual([r.ok, r.startPrice], [true, 8000], '待機中でも変えられる（始まる前に決められる）');
  assert.equal((await A.cmd('start', { lotId: lot.id })).ok, true);
  assert.equal((await A.cmd('set_start', { lotId: lot.id, amount: 8000 })).message, 'いまの開始値と同じです');
  assert.match((await A.cmd('set_start', { lotId: lot.id, amount: 0 })).message, /1円以上/);
  assert.equal((await A.cmd('set_start', { lotId: lot.id, amount: 6000 })).ok, true, '受付中でも、入札がなければ変えられる');
  await sleep(50);
  assert.equal(m[0].lots.get(lot.id).startPrice, 6000, '会員の画面にも、新しい開始値が届く');
  r = await m[0].bid(lot.id, 5999);
  assert.equal(r.code, 'BELOW_MINIMUM', '入札は、新しい開始値から');
  assert.equal((await m[0].bid(lot.id, 6000)).accepted, true);
  assert.match((await A.cmd('set_start', { lotId: lot.id, amount: 5000 })).message, /入札があるので/);
  await A.cmd('close', { lotId: lot.id });

  const lot2 = await createLot(A, 10000, null, '花瓶', 15000);
  await A.cmd('set_start', { lotId: lot2.id, amount: 16000 });
  await sleep(50);
  assert.equal(A.lots.get(lot2.id).reservePrice, null, '最低落札額以上の開始値にしたら、最低落札額はなくなる（最初の入札で届くため）');
});

test('うりきり: 最低落札額をなくす。締めると、最低落札額に届かない額でも落札になる', async () => {
  const lot = await createLot(A, 10000, null, '茶碗', 20000);
  await A.cmd('start', { lotId: lot.id });
  assert.equal((await m[0].bid(lot.id, 10000)).accepted, true);
  await sleep(50);
  assert.equal(m[1].lots.get(lot.id).urikiri, false);
  assert.equal((await A.cmd('urikiri', { lotId: lot.id })).ok, true);
  await sleep(50);
  assert.equal(m[1].lots.get(lot.id).urikiri, true, '会員の画面の「うりきり」が点く');
  assert.equal((await A.cmd('urikiri', { lotId: lot.id })).message, 'すでに、うりきりです');
  assert.match((await A.cmd('pass', { lotId: lot.id })).message, /うりきりで入札がある/, 'うりきりの入札がある品は、流札にできない');
  const r = await A.cmd('close', { lotId: lot.id });
  assert.deepEqual([r.status, r.amount], ['sold', 10000]);
});

test('流札: 入札がない品・最低落札額に届かない品を、売らずに終える', async () => {
  const lot = await createLot(A, 10000, null, '掛け軸');
  assert.match((await A.cmd('pass', { lotId: lot.id })).message, /流札にできません/, '始まる前は、流札にできない');
  await A.cmd('start', { lotId: lot.id });
  let r = await A.cmd('pass', { lotId: lot.id });
  assert.deepEqual([r.ok, r.status], [true, 'unsold']);
  assert.equal((await m[0].bid(lot.id, 10000)).code, 'AFTER_CLOSE', '流札のあとは、入札できない');

  const lot2 = await createLot(A, 10000, null, '香炉', 30000);
  await A.cmd('start', { lotId: lot2.id });
  await m[0].bid(lot2.id, 10000);
  r = await A.cmd('pass', { lotId: lot2.id });
  assert.deepEqual([r.ok, r.status], [true, 'unsold'], '最低落札額に届いていない入札があっても、流札にできる');
});
