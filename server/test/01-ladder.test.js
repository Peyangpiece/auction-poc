import test from 'node:test';
import assert from 'node:assert/strict';
import { unitFor, nextStep, minimumBid, isOnLadder, validateTable } from '../src/ladder.js';

const table = [{ lt: 10000, unit: 500 }, { unit: 1000 }]; // P2-4 の例

test('価格帯をまたぐ段: 9,500 → 10,000 → 11,000 → 12,000（AC-FR-BID-003-4）', () => {
  assert.equal(nextStep(9500, table), 10000);
  assert.equal(nextStep(10000, table), 11000);
  assert.equal(nextStep(11000, table), 12000);
});
test('最低入札額: 入札がなければ開始価格（AC-FR-BID-003-5）、あれば次の段', () => {
  assert.equal(minimumBid(9500, null, table), 9500);
  assert.equal(minimumBid(9500, 9500, table), 10000);
  assert.equal(minimumBid(9500, 11000, table), 12000);
});
test('段に乗っているか', () => {
  for (const ok of [9500, 10000, 11000, 12000, 50000]) assert.equal(isOnLadder(ok, 9500, table), true, String(ok));
  for (const ng of [9000, 9600, 10500, 11500, 9500.5, NaN]) assert.equal(isOnLadder(ng, 9500, table), false, String(ng));
  // 途中の段（最低入札額）から数えても同じ結果になる
  assert.equal(isOnLadder(13000, 9500, table, null, 12000), true);
  assert.equal(isOnLadder(10000, 9500, table, null, 12000), true); // 最低入札額より低いが段には乗っている
  assert.equal(isOnLadder(10500, 9500, table, null, 12000), false);
});
test('商品ごとの上書きがあれば、すべての価格帯でその単位（FR-BID-005）', () => {
  assert.equal(unitFor(5000, table, 300), 300);
  assert.equal(unitFor(50000, table, 300), 300);
});
test('表の検証', () => {
  assert.throws(() => validateTable([]));
  assert.throws(() => validateTable([{ lt: 100, unit: 10 }]));
  assert.throws(() => validateTable([{ lt: 100, unit: 0 }, { unit: 10 }]));
  validateTable(table);
});
