// 置き場が消える環境（Cloudflare のコンテナ）のための、保存と復元。
// 保存先は、本物と同じ出し入れの処理（cloudflare/store.js）に、R2 の代わりの入れ物をつないで立てる。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { createSaver, restore, DB_KEY } from '../src/persist.js';
import { handleStore } from '../../cloudflare/store.js';

// R2 の代わり（使っている操作だけ）
function fakeBucket() {
  const objects = new Map();
  return {
    objects,
    async list({ prefix, cursor }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const from = cursor ? Number(cursor) : 0; // 2個ずつ返して、続きの読み込みも通す
      const page = keys.slice(from, from + 2);
      return { objects: page.map((key) => ({ key, size: objects.get(key).length })), truncated: from + 2 < keys.length, cursor: String(from + 2) };
    },
    async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; },
    async put(key, body) { objects.set(key, Buffer.from(body)); },
    async delete(key) { objects.delete(key); },
  };
}
async function storeServer(bucket) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const hasBody = req.method === 'PUT';
    let r;
    try { r = await handleStore(new Request(`http://store${req.url}`, { method: req.method, body: hasBody ? Buffer.concat(chunks) : undefined }), bucket); }
    catch { r = new Response('error', { status: 500 }); }
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream' });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
const machine = (url) => loadConfig({ POC_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'auction-persist-')), POC_PERSIST_URL: url });

test('保存したデータベースとファイルが、真っさらな置き場に戻る', async () => {
  const bucket = fakeBucket();
  const { server, url } = await storeServer(bucket);
  // 1台目: 書き込んで、保存する
  const a = machine(url);
  const storeA = openDb(a.dbPath);
  storeA.db.exec('CREATE TABLE t_persist (v TEXT)');
  storeA.db.prepare('INSERT INTO t_persist VALUES (?)').run('一回目');
  fs.mkdirSync(path.join(a.dataDir, 'invoices'), { recursive: true });
  fs.writeFileSync(path.join(a.dataDir, 'invoices', '20261207-0001.pdf'), 'PDF の中身');
  fs.writeFileSync(path.join(a.dataDir, 'staff-initial-admin.txt'), '控え');
  const saver = createSaver({ db: storeA.db, config: a });
  await saver.flush();
  assert.equal(saver.status().lastError, null);
  assert.equal(saver.status().pending, false);
  assert.ok(bucket.objects.has('data/' + DB_KEY));
  assert.ok([...bucket.objects.keys()].some((k) => k.startsWith('data/history/auction-')), '日ごとの控えも置く');
  // 変わっていなければ、送り直さない
  const before = bucket.objects.get('data/' + DB_KEY);
  await saver.flush();
  assert.equal(bucket.objects.get('data/' + DB_KEY), before);
  // 書き足す・ファイルを消す → 次の保存で反映される
  storeA.db.prepare('INSERT INTO t_persist VALUES (?)').run('二回目');
  fs.rmSync(path.join(a.dataDir, 'staff-initial-admin.txt'));
  assert.equal(saver.status().pending, true);
  await saver.flush();
  assert.ok(!bucket.objects.has('data/staff-initial-admin.txt'));
  storeA.db.close();

  // 2台目: 何もない置き場に戻す
  const b = machine(url);
  await restore(b, { log: () => {} });
  const storeB = openDb(b.dbPath);
  assert.deepEqual(storeB.db.prepare('SELECT v FROM t_persist ORDER BY rowid').all().map((r) => r.v), ['一回目', '二回目']);
  assert.equal(fs.readFileSync(path.join(b.dataDir, 'invoices', '20261207-0001.pdf'), 'utf8'), 'PDF の中身');
  assert.ok(!fs.existsSync(path.join(b.dataDir, 'history')), '日ごとの控えは、戻さない');
  storeB.db.close();
  server.close();
});

test('保存先に届かないときは、復元が失敗で終わる（空のデータで上書きしない）', async () => {
  const { server, url } = await storeServer(fakeBucket());
  server.close();
  await assert.rejects(restore(machine(url), { retries: 2, waitMs: 10, log: () => {} }), /保存先に届きません/);
});

test('保存に失敗したら記録に残り、保存先が戻れば、まとめて送られる', async () => {
  const bucket = fakeBucket();
  const { server, url } = await storeServer(bucket);
  const a = machine(url);
  const storeA = openDb(a.dbPath);
  const saver = createSaver({ db: storeA.db, config: a, log: () => {} });
  const put = bucket.put;
  bucket.put = async () => { throw new Error('止まっている'); };
  await saver.flush();
  assert.ok(saver.status().lastError);
  assert.equal(saver.status().pending, true);
  bucket.put = put;
  await saver.flush();
  assert.equal(saver.status().lastError, null);
  assert.equal(saver.status().pending, false);
  storeA.db.close();
  server.close();
});

test('保存先は、置き場の外を指す名前を断る', async () => {
  const bucket = fakeBucket();
  const r = await handleStore(new Request('http://store/file/..%2Fsecret', { method: 'PUT', body: 'x' }), bucket);
  assert.equal(r.status, 400);
  assert.equal(bucket.objects.size, 0);
});

test('保存先のデータベースが壊れていたら、日ごとの控えから戻す。戻したファイルは、送り直さない', async () => {
  const bucket = fakeBucket();
  const { server, url } = await storeServer(bucket);
  const a = machine(url);
  const storeA = openDb(a.dbPath);
  storeA.db.exec('CREATE TABLE t_persist (v TEXT)');
  storeA.db.prepare('INSERT INTO t_persist VALUES (?)').run('控えにある');
  fs.mkdirSync(path.join(a.dataDir, 'invoices'), { recursive: true });
  fs.writeFileSync(path.join(a.dataDir, 'invoices', 'a.pdf'), 'PDF');
  await createSaver({ db: storeA.db, config: a }).flush();
  storeA.db.close();
  bucket.objects.set('data/' + DB_KEY, Buffer.from('こわれた中身'));

  const b = machine(url);
  const logs = [];
  await restore(b, { log: (m) => logs.push(m) });
  assert.ok(logs.some((m) => /日ごとの控え/.test(m)));
  const storeB = openDb(b.dbPath);
  assert.equal(storeB.db.prepare('SELECT v FROM t_persist').get().v, '控えにある');
  // 2台目の最初の保存: 戻したばかりの請求書は、送り直さない。データベースは、送る
  const puts = [];
  const put = bucket.put;
  bucket.put = async (key, body) => { puts.push(key); return put(key, body); };
  await createSaver({ db: storeB.db, config: b }).flush();
  assert.ok(puts.includes('data/' + DB_KEY));
  assert.ok(!puts.includes('data/invoices/a.pdf'));
  storeB.db.close();
  server.close();
});

test('送ったメールの控え・最初の管理者の控えは、保存先に送らない。前の版で送ってあったものは、復元のときに保存先から消す（報告書 102 章）', async () => {
  const bucket = fakeBucket();
  const { server, url } = await storeServer(bucket);
  // 前の版で送ってしまっていた控え
  await bucket.put('data/outbox/outbox.ndjson', Buffer.from('{"body":"パスワード"}'));
  await bucket.put('data/staff-initial-admin.txt', Buffer.from('鍵'));
  const a = machine(url);
  await restore(a, { log: () => {} });
  assert.ok(!fs.existsSync(path.join(a.dataDir, 'outbox', 'outbox.ndjson')), '戻さない');
  assert.ok(!bucket.objects.has('data/outbox/outbox.ndjson') && !bucket.objects.has('data/staff-initial-admin.txt'), '保存先から消す');
  const store = openDb(a.dbPath);
  fs.mkdirSync(path.join(a.dataDir, 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(a.dataDir, 'outbox', 'outbox.ndjson'), '{"body":"認証番号 123456"}\n');
  fs.writeFileSync(path.join(a.dataDir, 'staff-initial-admin.txt'), '鍵');
  const saver = createSaver({ db: store.db, config: a });
  await saver.flush();
  assert.ok(![...bucket.objects.keys()].some((k) => k.includes('outbox') || k.includes('staff-initial')), '送らない');
  store.db.close();
  server.close();
});

test('保存先のデータベースが壊れていたら、日ごとの控えから戻す（中身の確かめ。本番運用の評価 A9）', async () => {
  const zlib = await import('node:zlib');
  const bucket = fakeBucket();
  const { server, url } = await storeServer(bucket);
  // 正しい控え（きのう）を作る
  const a = machine(url);
  const storeA = openDb(a.dbPath);
  storeA.db.exec('CREATE TABLE t_ok (v TEXT)'); storeA.db.prepare('INSERT INTO t_ok VALUES (?)').run('控え');
  storeA.db.close();
  await bucket.put('data/history/auction-20261201.db.gz', zlib.gzipSync(fs.readFileSync(a.dbPath)));
  // 最新は、先頭だけデータベースの形で、中身が壊れている
  await bucket.put('data/' + DB_KEY, zlib.gzipSync(Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(8192, 7)])));
  const b = machine(url);
  const logs = [];
  await restore(b, { log: (m) => logs.push(m) });
  const storeB = openDb(b.dbPath);
  assert.equal(storeB.db.prepare('SELECT v FROM t_ok').get().v, '控え');
  assert.ok(logs.some((m) => m.includes('壊れています')));
  storeB.db.close();
  server.close();
});

test('保存先から取るのに失敗しただけでは、古い控えに戻さない（やり直して、だめなら起動を止める）', async () => {
  const bucket = fakeBucket();
  const { server, url } = await storeServer(bucket);
  const a = machine(url);
  const storeA = openDb(a.dbPath);
  storeA.db.exec('CREATE TABLE t_persist (v TEXT)');
  storeA.db.prepare('INSERT INTO t_persist VALUES (?)').run('朝の控えにある');
  const saver = createSaver({ db: storeA.db, config: a });
  await saver.flush();                                   // 日ごとの控えにも入る
  storeA.db.prepare('INSERT INTO t_persist VALUES (?)').run('そのあとの書き込み');
  await saver.flush();                                   // 最新の写しにだけ入る（控えは、1時間に1回）
  storeA.db.close();
  const get = bucket.get;
  // 1) 最新の写しを取るのが、2回だけ失敗する → やり直して、最新を戻す
  let fails = 2;
  bucket.get = async (key) => { if (key === 'data/' + DB_KEY && fails-- > 0) throw new Error('一時的な失敗'); return get(key); };
  const b = machine(url);
  await restore(b, { retries: 5, waitMs: 5, log: () => {} });
  const storeB = openDb(b.dbPath);
  assert.deepEqual(storeB.db.prepare('SELECT v FROM t_persist ORDER BY rowid').all().map((r) => r.v), ['朝の控えにある', 'そのあとの書き込み']);
  storeB.db.close();
  // 2) ずっと取れない → 古い控えには戻さず、失敗で終わる
  bucket.get = async (key) => { if (key === 'data/' + DB_KEY) throw new Error('取れない'); return get(key); };
  const c = machine(url);
  await assert.rejects(restore(c, { retries: 2, waitMs: 5, log: () => {} }), /取れません/);
  assert.ok(!fs.existsSync(c.dbPath));
  server.close();
});

test('書き込みの控え（journal/）は、速い置き場に置く。ほかは R2。一覧は両方。前の版が R2 に置いた控えも読める', async () => {
  const bucket = fakeBucket();
  const quick = new Map();
  const fast = {
    async list() { return [...quick].map(([key, v]) => ({ key, size: v.byteLength })); },
    async get(key) { return quick.get(key) ?? null; },
    async put(key, body) { quick.set(key, new Uint8Array(body)); },
    async delete(key) { quick.delete(key); },
  };
  const call = (method, p, body) => handleStore(new Request(`http://store${p}`, { method, body }), bucket, fast);
  assert.equal((await call('PUT', '/file/journal/000000000001-000000000002.json.gz', '新しい控え')).status, 200);
  assert.equal((await call('PUT', '/file/db/auction.db.gz', '写し')).status, 200);
  assert.deepEqual([...quick.keys()], ['journal/000000000001-000000000002.json.gz']);
  assert.deepEqual([...bucket.objects.keys()], ['data/db/auction.db.gz'], '控えは、R2 には置かない');
  // 前の版が R2 に置いた控え
  bucket.objects.set('data/journal/000000000000-000000000000.json.gz', Buffer.from('前の版の控え'));
  const files = (await (await call('GET', '/manifest')).json()).files.map((f) => f.path).sort();
  assert.deepEqual(files, ['db/auction.db.gz', 'journal/000000000000-000000000000.json.gz', 'journal/000000000001-000000000002.json.gz']);
  assert.equal(await (await call('GET', '/file/journal/000000000001-000000000002.json.gz')).text(), '新しい控え');
  assert.equal(await (await call('GET', '/file/journal/000000000000-000000000000.json.gz')).text(), '前の版の控え');
  // 消すときは、両方から
  for (const f of files.filter((x) => x.startsWith('journal/'))) assert.equal((await call('DELETE', '/file/' + f)).status, 200);
  assert.equal(quick.size, 0);
  assert.deepEqual([...bucket.objects.keys()], ['data/db/auction.db.gz']);
});
