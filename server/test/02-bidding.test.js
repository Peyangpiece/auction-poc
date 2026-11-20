// 入札の受理・拒否と、状態遷移（本仕様 FR-BID-003・012、8.6）。P2-4 を含む。
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

test('P2-4 価格帯をまたぐ入札: 9,500 → 10,000 → 11,000 円と受理される', async () => {
  const lot = await createLot(A, 9500);
  assert.equal((await m[0].bid(lot.id, 9500)).code, 'LOT_NOT_OPEN'); // 待機中は受け付けない
  assert.equal((await A.cmd('start', { lotId: lot.id })).ok, true);

  let r = await m[0].bid(lot.id, 9500); // 最初の入札は開始価格で受理（AC-FR-BID-003-5）
  assert.deepEqual([r.accepted, r.currentPrice, r.minBid], [true, 9500, 10000]);
  r = await m[0].bid(lot.id, 10000); // 自分への上乗せ（AC-FR-BID-003-2）
  assert.equal(r.code, 'ALREADY_HIGHEST');
  r = await m[1].bid(lot.id, 10000);
  assert.deepEqual([r.accepted, r.minBid], [true, 11000]);
  r = await m[2].bid(lot.id, 11000);
  assert.deepEqual([r.accepted, r.minBid, r.minAllowed], [true, 12000, 11001]);
  r = await m[0].bid(lot.id, 11000); // 古い価格での入札（AC-FR-BID-003-1）
  assert.deepEqual([r.code, r.currentPrice, r.minAllowed], ['BELOW_MINIMUM', 11000, 11001]);
  r = await m[0].bid(lot.id, 12000); // まだ有効な入札（AC-FR-BID-003-3）
  assert.equal(r.accepted, true);

  const res = await A.cmd('close', { lotId: lot.id });
  assert.deepEqual([res.ok, res.status, res.amount, res.paddle], [true, 'sold', 12000, m[0].paddle]);
  assert.equal((await m[1].bid(lot.id, 13000)).code, 'AFTER_CLOSE');
  const log = await lotLog(A, lot.id);
  assert.deepEqual(log.bids.filter((b) => b.result === 'ACCEPTED').map((b) => b.amount), [9500, 10000, 11000, 12000]);
});

test('開始価格以上なら、1円単位で入札できる（価格の段に合わせなくてよい。発注者の決定）', async () => {
  const lot = await createLot(A, 9500);
  assert.equal((await A.cmd('start', { lotId: lot.id })).ok, true);
  let r = await m[0].bid(lot.id, 9499); // 開始価格より低い
  assert.deepEqual([r.code, r.minAllowed], ['BELOW_MINIMUM', 9500]);
  r = await m[0].bid(lot.id, 9501); // 段（500円）に乗っていなくても、開始価格以上なら受理
  assert.deepEqual([r.accepted, r.currentPrice, r.minAllowed, r.minBid], [true, 9501, 9502, 10000]); // 目安は、段の上にそろえる
  r = await m[1].bid(lot.id, 9501); // 同じ額は、上回っていないので断る
  assert.equal(r.code, 'BELOW_MINIMUM');
  r = await m[1].bid(lot.id, 9502); // 1円だけ上
  assert.deepEqual([r.accepted, r.currentPrice], [true, 9502]);
  r = await m[2].bid(lot.id, 10500); // 1万円以上の帯でも、段の 1,000円単位でなくてよい
  assert.deepEqual([r.accepted, r.currentPrice], [true, 10500]);
  r = await m[0].bid(lot.id, 10500.5); // 1円未満は入札できない
  assert.equal(r.code, 'OFF_LADDER');
  await A.cmd('close', { lotId: lot.id });
  const log = await lotLog(A, lot.id);
  assert.deepEqual(log.bids.filter((b) => b.result === 'ACCEPTED').map((b) => b.amount), [9501, 9502, 10500]);
});

test('けた外れの入札は断る（1人の入札で、ほかの人が入札できなくなるのを防ぐ）', async () => {
  const lot = await createLot(A, 1000);
  assert.equal((await A.cmd('start', { lotId: lot.id })).ok, true);
  // 入札できる最も低い額（1,000円）の2倍か、＋10万円の、大きいほうまで
  assert.equal((await m[0].bid(lot.id, Number.MAX_SAFE_INTEGER)).code, 'TOO_HIGH');
  assert.equal((await m[0].bid(lot.id, 1e10 + 1)).code, 'TOO_HIGH');
  assert.equal((await m[0].bid(lot.id, 101001)).code, 'TOO_HIGH');
  assert.equal((await m[0].bid(lot.id, 101000)).accepted, true);
  // 次は、101,001円の2倍まで（組んだ2人が交互に入れても、1回で上げられるのは2倍まで）
  assert.equal((await m[1].bid(lot.id, 202003)).code, 'TOO_HIGH');
  const r = await m[1].bid(lot.id, 202002);
  assert.deepEqual([r.accepted, r.currentPrice], [true, 202002]);
  await A.cmd('close', { lotId: lot.id });
});

test('入札が1件もないまま締めると流札（AC-FR-CLS-002-2）', async () => {
  const lot = await createLot(A, 3000);
  await A.cmd('start', { lotId: lot.id });
  const res = await A.cmd('close', { lotId: lot.id });
  assert.deepEqual([res.ok, res.status, res.amount], [true, 'unsold', null]);
});

test('8.6 の表にない遷移は拒否し、理由を返す。進行中のロットは同時に1つまで', async () => {
  const a = await createLot(A, 1000);
  const b = await createLot(A, 1000);
  for (const action of ['close', 'suspend', 'resume', 'cancel', 'start_without_video', 'back_to_waiting']) {
    const r = await A.cmd(action, { lotId: a.id, reason: 'x' });
    assert.equal(r.ok, false, action);
    assert.ok(r.message, action);
  }
  assert.equal((await A.cmd('exclude', { lotId: b.id })).ok, false); // 理由が必須
  assert.equal((await A.cmd('start', { lotId: a.id })).ok, true);
  assert.equal((await A.cmd('start', { lotId: b.id })).ok, false); // 同時に1つまで
  assert.equal((await A.cmd('start', { lotId: a.id })).ok, false);
  assert.equal((await A.cmd('exclude', { lotId: a.id, reason: 'x' })).ok, false);

  // 中断 → 再開（現在価格はそのまま）
  assert.equal((await m[0].bid(a.id, 1000)).accepted, true);
  assert.equal((await A.cmd('suspend', { lotId: a.id })).ok, true);
  assert.equal((await m[1].bid(a.id, 1500)).code, 'LOT_NOT_OPEN');
  assert.equal((await A.cmd('resume', { lotId: a.id })).ok, true);
  assert.equal(A.lots.get(a.id).currentPrice, 1000);
  assert.equal((await m[1].bid(a.id, 1500)).accepted, true);

  // 中断 → 取りやめ: すべての入札を無効にして待機に戻す（記録は消さない。FR-BID-007）
  await A.cmd('suspend', { lotId: a.id });
  assert.equal((await A.cmd('cancel', { lotId: a.id })).ok, false); // 理由が必須
  assert.equal((await A.cmd('cancel', { lotId: a.id, reason: '商品の取り違え' })).ok, true);
  const log = await lotLog(A, a.id);
  assert.equal(log.lot.status, 'waiting');
  assert.equal(log.lot.currentPrice, null);
  assert.equal(log.bids.filter((x) => x.result === 'ACCEPTED').length, 2);
  assert.ok(log.bids.filter((x) => x.result === 'ACCEPTED').every((x) => x.valid === 0));

  // 取りやめたロットは、開始価格からやり直せる
  assert.equal((await A.cmd('start', { lotId: a.id })).ok, true);
  assert.equal((await m[2].bid(a.id, 1000)).accepted, true);
  assert.equal((await A.cmd('close', { lotId: a.id })).status, 'sold');
  assert.equal((await A.cmd('close', { lotId: a.id })).ok, false); // 終了したロットはもう変わらない
  assert.equal((await A.cmd('exclude', { lotId: b.id, reason: '出品取り下げ' })).ok, true);
  assert.equal((await A.cmd('start', { lotId: b.id })).ok, false);
});

test('会員は進行役の操作ができず、進行役は入札できない（FR-CON-004）', async () => {
  const lot = await createLot(A, 1000);
  const got = m[0].waitFor((x) => x.type === 'error');
  m[0].send({ type: 'cmd', action: 'start', lotId: lot.id });
  assert.match((await got).message, /進行役だけ/);
  const got2 = A.waitFor((x) => x.type === 'error');
  A.send({ type: 'bid', lotId: lot.id, amount: 1000 });
  assert.match((await got2).message, /入札できません/);
});
