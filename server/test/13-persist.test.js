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
