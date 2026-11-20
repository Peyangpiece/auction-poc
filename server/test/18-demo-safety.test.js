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
  return { store, post, close: async () => { await new Promise((r) => server.close(r)); await api.billing.filesIdle(); store.db.close(); } };
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

test('メールは、1通ずつ間隔をあけて送る（送信サービスの速さの上限に当たらないように。本番運用の評価 B11）', async () => {
  const { Notifier } = await import('../src/mvp/notify.js');
  const at = [];
  const n = new Notifier(async () => { at.push(Date.now()); }, () => {}, { intervalMs: 60 });
  await Promise.all([1, 2, 3, 4].map((i) => n.email(`m${i}@example.com`, 'event', '件名', '本文')));
  assert.equal(at.length, 4);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 55, `間隔 ${at[i] - at[i - 1]}ms`);
});

test('保存の失敗などの緊急の知らせは、主催者管理者と主催者の連絡先へメールで送る。同じ種類は1時間に1回まで（本番運用の評価 A8）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auction-alert-'));
  const config = loadConfig({ POC_DATA_DIR: dir });
  const store = openDb(config.dbPath);
  const api = createApi({ store, config, nowMs: () => Date.now() });
  try {
    api.inviteStaff({ email: 'boss@example.com', name: '管理', role: 'admin' });
    store.db.prepare("INSERT INTO settings (key, value) VALUES ('org_email', 'office@example.com') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    assert.equal(api.alertAdmins('persist', '保存先にデータを保存できていません', ['理由: 止まっている']), true);
    assert.equal(api.alertAdmins('persist', '保存先にデータを保存できていません', ['理由: 止まっている']), false, '1時間に1回まで');
    await new Promise((r) => setTimeout(r, 100));
    const sent = fs.readFileSync(path.join(dir, 'outbox', 'outbox.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((m) => m.kind === 'alert');
    assert.deepEqual(sent.map((m) => m.to).sort(), ['boss@example.com', 'office@example.com']);
    assert.match(sent[0].subject, /【緊急】保存先/);
  } finally { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
