// お試し用の設定（認証番号を画面に出す）でも、なりすましを許さない（本番運用の評価 A1。報告書 102 章）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { createApi } from '../src/mvp/api.js';

async function boot(dataDir, env) {
  const config = loadConfig({ POC_DATA_DIR: dataDir, POC_AUTH_RATE: '0', POC_AUTO_APPROVE: '1', ...env });
  const store = openDb(config.dbPath);
  const api = createApi({ store, config, nowMs: () => Date.now() });
  const server = http.createServer((req, res) => api.handle(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (u, b, cookie = '') => {
    const r = await fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(b ?? {}) });
    return { status: r.status, json: await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
  };
  return { store, post, close: async () => { await new Promise((r) => server.close(r)); store.db.close(); } };
}

test('お試し用でも、ログインの認証番号は返事に入れない。本番の設定に切り替えると、お試しのあいだのログインを消す', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auction-demo-'));
  const demo = await boot(dir, { POC_DEV_SHOW_CODES: '1' });
  try {
    const s = await demo.post('/api/register/start', { id: '09012340001' });
    assert.ok(s.json.devCode, '登録の認証番号は、お試し用では出す（本人の端末で登録するため）');
    const v = await demo.post('/api/register/verify', { id: '09012340001', code: s.json.devCode });
    const done = await demo.post('/api/register/complete', { kind: 'b2c', name: '検証 一郎', email: 'a1@example.com', address: '東京都', adult: true, agreed: true }, v.cookie);
    assert.equal(done.status, 200);
    // 攻撃者: 会員のメールアドレスを知っているだけ
    const login = await demo.post('/api/login/start', { id: 'a1@example.com' });
    assert.equal(login.status, 200);
    assert.equal(login.json.devCode, undefined, 'ログインの認証番号は、お試し用でも返さない');
    assert.ok(demo.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n > 0);
  } finally { await demo.close(); }
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'outbox', 'outbox.ndjson'), '{}\n');
  const prod = await boot(dir, {});
  try {
    assert.equal(prod.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'お試しのあいだのログインは、すべて消える');
    assert.ok(!fs.existsSync(path.join(dir, 'outbox', 'outbox.ndjson')), '送ったメールの控えも消える');
  } finally { await prod.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
