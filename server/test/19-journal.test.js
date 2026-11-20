// 書き込みの控え（ジャーナル）: 受理した入札や落札を、返事の前に外の保存先へ書き、起動のときにやり直す。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { createJournal, replayJournal, parseJournalKey, journalSeq } from '../src/journal.js';
import { handleStore } from '../../cloudflare/store.js';
import { makeEnv, startServer, connect, cleanup, createLot, sleep, ROOT } from './helpers.js';

const execFileP = promisify(execFile);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'auction-journal-'));
const dump = (db) => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 't_%' ORDER BY name").all()
  .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
const filesOf = (map) => [...map.keys()].map((rel) => ({ rel, ...parseJournalKey(rel) })).filter((f) => f.first);
// 世代の印を書いてから写しを取り、控えを始める（本物の起動と同じ順）
const beginWith = async (journal, db, snap) => { journal.begin(); if (snap) await db.backup(snap); journal.start(); };
async function until(cond, ms = 5000) { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('until: 時間切れ'); await sleep(10); } }

test('控え: 1文・トランザクション・取り消されたトランザクション・入れ子を、写しの上にやり直すと、元と同じになる', async () => {
  const dir = tmp();
  const store = openDb(path.join(dir, 'a.db'));
  const db = store.db;
  db.exec('CREATE TABLE t_a (id INTEGER PRIMARY KEY, v TEXT, n INTEGER); CREATE TABLE t_b (k TEXT PRIMARY KEY, blob BLOB)');
  const remote = new Map();
  const journal = createJournal({ db, put: async (rel, body) => { remote.set(rel, body); }, del: async (rel) => { remote.delete(rel); } });
  db.prepare('INSERT INTO t_a (v, n) VALUES (?, ?)').run('始める前', 0); // 見張りを始める前の書き込みは、控えない
  await beginWith(journal, db, null);
  const ins = db.prepare('INSERT INTO t_a (v, n) VALUES (?, ?)');
  ins.run('1文', 1);
  db.transaction(() => { ins.run('まとめて1', 2); ins.run('まとめて2', 3); db.prepare('INSERT INTO t_b VALUES (@k, @blob)').run({ k: 'x', blob: Buffer.from([1, 2, 3]) }); })();
  await journal.durable();
  // ここで写しを取る（このあとの書き込みは、控えからやり直す）
  await db.backup(path.join(dir, 'snap.db'));
  const snapSeq = journal.seq;
  assert.throws(() => db.transaction(() => { ins.run('取り消される', 9); throw new Error('やめる'); })(), /やめる/);
  db.transaction(() => {
    ins.run('外', 4);
    try { db.transaction(() => { ins.run('内（取り消される）', 9); throw new Error('内だけやめる'); })(); } catch { /* 外は続ける */ }
    ins.run('外の続き', 5);
  })();
  db.prepare('UPDATE t_a SET n = n + 100 WHERE v = ?').run('1文');
  db.prepare('DELETE FROM t_a WHERE v = ?').run('まとめて2');
  assert.throws(() => db.prepare('INSERT INTO t_b VALUES (?, ?)').run('x', null), /UNIQUE/); // 失敗した文は、控えない
  await journal.durable();
  assert.equal(journal.clean(), true);
  assert.equal(journalSeq(db), journal.seq, 'データベースの中の番号と、控えの番号が合う');

  const copy = new Database(path.join(dir, 'snap.db'));
  const r = await replayJournal(copy, filesOf(remote), async (rel) => remote.get(rel), { log: () => {} });
  assert.equal(r.stoppedAt, null);
  assert.equal(r.applied, journal.seq - snapSeq);
  assert.deepEqual(dump(copy), dump(db));
  // もう一度やり直しても、変わらない（同じ書き込みを、2回入れない）
  const again = await replayJournal(copy, filesOf(remote), async (rel) => remote.get(rel), { log: () => {} });
  assert.equal(again.applied, 0);
  assert.deepEqual(dump(copy), dump(db));
  // 写しに入った分の控えは、消せる
  await journal.prune(journal.seq);
  assert.equal(filesOf(remote).length, 0);
  copy.close(); db.close();
});

test('控え: 番号が途切れていたら、そこで止める', async () => {
  const dir = tmp();
  const { db } = openDb(path.join(dir, 'a.db'));
  db.exec('CREATE TABLE t_a (v TEXT)');
  const remote = new Map();
  const journal = createJournal({ db, put: async (rel, body) => { remote.set(rel, body); }, del: async () => {} });
  await beginWith(journal, db, path.join(dir, 'snap.db'));
  for (const v of ['一', '二', '三']) { db.prepare('INSERT INTO t_a VALUES (?)').run(v); await journal.durable(); }
  const files = filesOf(remote).sort((a, b) => a.first - b.first);
  assert.equal(files.length, 3);
  remote.delete(files[1].rel); // まん中の控えが無い
  const copy = new Database(path.join(dir, 'snap.db'));
  const logs = [];
  const r = await replayJournal(copy, filesOf(remote), async (rel) => remote.get(rel), { log: (m) => logs.push(m) });
  assert.deepEqual([r.applied, r.stoppedAt], [1, 3]);
  assert.deepEqual(copy.prepare('SELECT v FROM t_a').all().map((x) => x.v), ['一']);
  assert.ok(logs.some((m) => /途切れています/.test(m)));
  copy.close(); db.close();
});

test('控え: 返事は、保存先に届いてから出る。届かないときは、決めた時間で先に出して、知らせる。戻れば、元に戻る', async () => {
  const dir = tmp();
  const { db } = openDb(path.join(dir, 'a.db'));
  db.exec('CREATE TABLE t_a (v TEXT)');
  let mode = 'hold', release = null;
  const degraded = [];
  const journal = createJournal({
    db, maxWaitMs: 150, log: () => {}, onDegraded: (on) => degraded.push(on), del: async () => {},
    put: async () => { if (mode === 'hold') await new Promise((r) => { release = r; }); else if (mode === 'fail') throw new Error('止まっている'); },
  });
  journal.start();
  const order = [];
  journal.after(() => order.push('書き込みの前'));
  assert.deepEqual(order, ['書き込みの前'], '書き込みが無ければ、すぐ出る');
  db.prepare('INSERT INTO t_a VALUES (?)').run('入札');
  journal.after(() => order.push('入札の返事'));
  journal.after(() => order.push('価格の知らせ'));
  await sleep(40);
  assert.equal(order.length, 1, '届くまでは、出さない');
  assert.equal(journal.clean(), false);
  release();
  await until(() => order.length === 3);
  assert.deepEqual(order.slice(1), ['入札の返事', '価格の知らせ'], '順番は、頼んだ順');
  // 届かない: 150ms を超えたら、先に出す
  mode = 'fail';
  db.prepare('INSERT INTO t_a VALUES (?)').run('次の入札');
  journal.after(() => order.push('次の返事'));
  await sleep(60);
  assert.equal(order.length, 3);
  await until(() => order.length === 4);
  assert.deepEqual(degraded, [true]);
  assert.equal(journal.status().degraded, true);
  // 戻ったら、送り直して、元に戻る
  mode = 'ok';
  await until(() => journal.status().degraded === false);
  assert.deepEqual(degraded, [true, false]);
  assert.equal(journal.clean(), true);
  journal.stop(); db.close();
});

// 本物のサーバーを、外の保存先（R2 の代わり）につないで動かし、突然落として、別の置き場に戻す
function fakeStore() {
  const objects = new Map();
  const bucket = {
    async list({ prefix }) { return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key, size: objects.get(key).length })), truncated: false }; },
    async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; },
    async put(key, body) { objects.set(key, Buffer.from(body)); },
    async delete(key) { objects.delete(key); },
  };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    let r;
    try { r = await handleStore(new Request(`http://store${req.url}`, { method: req.method, body: req.method === 'PUT' ? Buffer.concat(chunks) : undefined }), bucket); } catch { r = new Response('error', { status: 500 }); }
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream' });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ objects, server, url: `http://127.0.0.1:${server.address().port}` })));
}

test('突然落ちても、受理した入札と落札は残る（写しを送る前でも、控えから戻る）', async () => {
  const remote = await fakeStore();
  // 写しは、起動のときの1回だけにする（60秒おき）。そのあとの書き込みは、控えだけが頼り
  const ctx = makeEnv({ POC_PERSIST_URL: remote.url, POC_PERSIST_INTERVAL_MS: '60000', POC_ALLOW_CRASH: '0' });
  let srv = await startServer(ctx), srv2 = null;
  try {
  const auctioneer = await connect(srv, ctx.tokens.auctioneer);
  const a = await connect(srv, ctx.tokens.members[0].token), b = await connect(srv, ctx.tokens.members[1].token);
  const lot1 = await createLot(auctioneer, 1000), lot2 = await createLot(auctioneer, 2000);
  await auctioneer.cmd('start', { lotId: lot1.id });
  await until(() => a.lots.get(lot1.id)?.status === 'open');
  assert.equal((await a.bid(lot1.id, 1000)).accepted, true);
  assert.equal((await b.bid(lot1.id, 1500)).accepted, true);
  const closed = await auctioneer.cmd('close', { lotId: lot1.id });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  await until(() => a.lots.get(lot1.id)?.status === 'sold');
  await auctioneer.cmd('start', { lotId: lot2.id });
  await until(() => a.lots.get(lot2.id)?.status === 'open');
  assert.equal((await a.bid(lot2.id, 2000)).accepted, true);
  assert.equal((await b.bid(lot2.id, 2600)).accepted, true);
  assert.equal((await a.bid(lot2.id, 3100)).accepted, true);
  // 返事が届いた直後に、突然落とす
  await srv.kill9(); srv = null;
  for (const c of [auctioneer, a, b]) c.close();
  assert.ok([...remote.objects.keys()].some((k) => k.startsWith('data/journal/')), '控えが、保存先にある');

  // 別の置き場（空）に戻して、起動する
  const dir2 = tmp();
  const env2 = { ...ctx.env, POC_DATA_DIR: dir2 };
  delete env2.POC_DB_PATH;
  // 保存先（このテストの中のサーバー）と話すので、止めずに待つ
  await execFileP('node', ['tools/persist-restore.js'], { cwd: ROOT, env: env2 });
  const db = new Database(path.join(dir2, 'auction.db'), { readonly: true });
  const lots = Object.fromEntries(db.prepare('SELECT l.id, l.status, b.amount AS current_price FROM lots l LEFT JOIN bids b ON b.seq = l.current_bid_seq').all().map((l) => [l.id, l]));
  assert.equal(lots[lot1.id].status, 'sold', '落札は、残る');
  assert.equal(lots[lot1.id].current_price, 1500);
  assert.equal(lots[lot2.id].current_price, 3100, '受理した入札は、残る');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bids WHERE result = 'ACCEPTED'").get().n, 5);
  db.close();
  srv2 = await startServer({ ...ctx, env: env2 });
  const health = await (await fetch(srv2.httpUrl + '/healthz')).json();
  assert.equal(health.journal.degraded, false);
  fs.rmSync(dir2, { recursive: true, force: true });
  } finally {
    await srv?.kill9().catch(() => {}); await srv2?.stop().catch(() => {});
    remote.server.close(); remote.server.closeAllConnections?.();
    cleanup(ctx);
  }
});

test('控え: 古い写しに戻したあと、前の世代の控えは混ざらない（番号が合っていても、使わない）', async () => {
  const dir = tmp();
  const remote = new Map();
  const put = async (rel, body) => { remote.set(rel, body); }, del = async (rel) => { remote.delete(rel); };
  // 第1世代: 写し（番号2）のあと、3〜4 を控えに書いて、落ちる
  const g1 = openDb(path.join(dir, 'g1.db'));
  g1.db.exec('CREATE TABLE t_a (v TEXT)');
  const j1 = createJournal({ db: g1.db, put, del });
  await beginWith(j1, g1.db, null);
  for (const v of ['1', '2']) g1.db.prepare('INSERT INTO t_a VALUES (?)').run(v);
  await j1.durable();
  await g1.db.backup(path.join(dir, 'old.db'));     // これが「古い写し」
  for (const v of ['3（前の世代）', '4（前の世代）']) g1.db.prepare('INSERT INTO t_a VALUES (?)').run(v);
  await j1.durable();
  g1.db.close();
  // 運用者が、古い写しに戻して、起動し直す（第2世代）。番号は 2 から続き、3 を書いて、落ちる
  fs.copyFileSync(path.join(dir, 'old.db'), path.join(dir, 'g2.db'));
  const g2 = openDb(path.join(dir, 'g2.db'));
  const j2 = createJournal({ db: g2.db, put, del });
  await beginWith(j2, g2.db, path.join(dir, 'snap2.db'));
  assert.notEqual(j2.epoch, j1.epoch);
  g2.db.prepare('INSERT INTO t_a VALUES (?)').run('3（新しい世代）');
  await j2.durable();
  g2.db.close();
  // 第2世代の写しに、控えをやり直す: 前の世代の「4」は、番号が続いていても、入らない
  const copy = new Database(path.join(dir, 'snap2.db'));
  const logs = [];
  const r = await replayJournal(copy, filesOf(remote), async (rel) => remote.get(rel), { log: (m) => logs.push(m) });
  assert.deepEqual(copy.prepare('SELECT v FROM t_a ORDER BY rowid').all().map((x) => x.v), ['1', '2', '3（新しい世代）']);
  assert.deepEqual([r.applied, r.stoppedAt], [1, null]);
  assert.ok(logs.some((m) => /別の世代/.test(m)));
  copy.close();
});

test('控え: 保存先が、エラーでなく無応答でも、決めた時間で返事を先に出す', async () => {
  const dir = tmp();
  const { db } = openDb(path.join(dir, 'a.db'));
  db.exec('CREATE TABLE t_a (v TEXT)');
  const degraded = [];
  let hang = true;
  const journal = createJournal({ db, maxWaitMs: 120, log: () => {}, onDegraded: (on) => degraded.push(on), del: async () => {},
    put: () => (hang ? new Promise((resolve) => { const t = setInterval(() => { if (!hang) { clearInterval(t); resolve(); } }, 10); }) : Promise.resolve()) });
  await beginWith(journal, db, null);
  const t0 = Date.now();
  db.prepare('INSERT INTO t_a VALUES (?)').run('入札');
  let answered = 0;
  journal.after(() => { answered = Date.now() - t0; });
  await until(() => answered > 0, 2000);
  assert.ok(answered >= 100 && answered < 600, `返事まで ${answered}ms`);
  assert.deepEqual(degraded, [true]);
  hang = false;
  await until(() => journal.status().degraded === false, 3000);
  assert.equal(journal.clean(), true);
  journal.stop(); db.close();
});

test('控え: 控えに入らない書き方（exec・bind・iterate）は、見張りを始めたあとは、エラーにする', async () => {
  const dir = tmp();
  const { db } = openDb(path.join(dir, 'a.db'));
  db.exec('CREATE TABLE t_a (v TEXT)');
  const journal = createJournal({ db, put: async () => {}, del: async () => {} });
  await beginWith(journal, db, null);
  assert.throws(() => db.exec("INSERT INTO t_a VALUES ('x')"), /db\.exec は、起動のあとは使えません/);
  assert.throws(() => db.prepare('INSERT INTO t_a VALUES (?)').bind('x'), /bind\(\) は使えません/);
  assert.throws(() => db.prepare('INSERT INTO t_a VALUES (?) RETURNING v').iterate('x'), /iterate\(\) は使えません/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t_a').get().n, 0);
  assert.equal([...db.prepare('SELECT v FROM t_a').iterate()].length, 0, '読むだけの文は、これまでどおり使える');
  journal.stop(); db.close();
});
