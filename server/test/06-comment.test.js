// コメント（20文字まで）。入札とは別の処理で、競りの結果には関わらない。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, startServer, connectAll, connect, cleanup, sleep } from './helpers.js';

let ctx, srv, A, m;
before(async () => {
  ctx = makeEnv({ POC_COMMENT_INTERVAL_MS: '300' });
  srv = await startServer(ctx);
  ({ auctioneer: A, members: m } = await connectAll(srv, ctx, 2));
});
after(async () => { await srv.stop(); cleanup(ctx); });

test('コメントは全員に届き、参加番号つきで表示できる。20文字を超えると拒否する', async () => {
  const got = m[1].waitFor((x) => x.type === 'comment');
  assert.equal((await m[0].comment('  状態はどうですか？  ')).ok, true);
  const c = await got;
  assert.deepEqual([c.paddle, c.text], [m[0].paddle, '状態はどうですか？']); // 前後の空白は落とす

  await sleep(350);
  assert.equal((await m[0].comment('あ'.repeat(20))).ok, true);
  await sleep(350);
  const long = await m[0].comment('あ'.repeat(21));
  assert.equal(long.ok, false);
  assert.match(long.message, /20文字まで/);
  assert.equal((await m[0].comment('   ')).ok, false);
});

test('続けての書き込みは間隔をあける。スタッフは書き込めない', async () => {
  await sleep(350);
  assert.equal((await m[1].comment('一つ目')).ok, true);
  const second = await m[1].comment('二つ目');
  assert.equal(second.ok, false);
  assert.match(second.message, /お待ちください/);
  const staff = await A.comment('進行役です');
  assert.equal(staff.ok, false);
});

test('後から入った人にも直近のコメントが見える。進行役が非表示にしたものは見えない', async () => {
  const late = await connect(srv, ctx.tokens.members[2].token);
  late.send({ type: 'sync' });
  const snap = await late.waitFor((x) => x.type === 'snapshot');
  assert.ok(snap.comments.some((c) => c.text === '一つ目'));
  const target = snap.comments.find((c) => c.text === '一つ目');
  const hidden = late.waitFor((x) => x.type === 'comment_hidden');
  assert.equal((await A.cmd('hide_comment', { id: target.id })).ok, true);
  assert.equal((await hidden).id, target.id);
  late.send({ type: 'sync' });
  const snap2 = await late.waitFor((x) => x.type === 'snapshot');
  assert.equal(snap2.comments.some((c) => c.id === target.id), false);
});
