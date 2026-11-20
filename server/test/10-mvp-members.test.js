// MVP の 1（会員登録・認証・スタッフ）と、開催・設定・監査ログ、進行コンソールからのその場での商品登録。
// 時刻を進められるように、API を同じプロセスの中で立てて確かめる。データはすべて架空のもの。
import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { createApi } from '../src/mvp/api.js';
import { totp, base32Encode, normalizePhone } from '../src/mvp/security.js';

async function setup(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auction-mvp-'));
  const config = loadConfig({ POC_DATA_DIR: dataDir, POC_AUTH_RATE: '0', POC_AUTO_APPROVE: '1', ...env });
  const store = openDb(config.dbPath);
  let shift = 0;
  const api = createApi({ store, config, nowMs: () => Date.now() + shift });
  const server = http.createServer((req, res) => api.handle(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  /** クッキーを覚える、ブラウザの代わり */
  const browser = () => {
    let cookie = '';
    const call = async (method, url, body, headers = {}) => {
      const isBuf = Buffer.isBuffer(body);
      const res = await fetch(base + url, {
        method, redirect: 'manual',
        headers: { ...(cookie ? { cookie } : {}), ...(method === 'POST' && !isBuf ? { 'content-type': 'application/json' } : {}), ...headers },
        body: method === 'POST' ? (isBuf ? body : JSON.stringify(body ?? {})) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 写真やリダイレクト */ }
      return { status: res.status, json, headers: res.headers, setCookie: set };
    };
    return { get: (u) => call('GET', u), post: (u, b, h) => call('POST', u, b, h) };
  };
  const outbox = () => {
    const file = path.join(dataDir, 'outbox', 'outbox.ndjson');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  const lastCode = (phone) => /認証番号は (\d{6})/.exec(outbox().filter((m) => m.channel === 'sms' && m.to === phone).at(-1).body)[1];
  const staffLogin = async (role, loginId, phone) => {
    const s = api.createStaff({ loginId, name: `${loginId} の人`, role, phone });
    const b = browser();
    const r = await b.post('/api/staff/login', { loginId, password: s.initialPassword, code: totp(s.totpSecret) });
    assert.equal(r.status, 200);
    return Object.assign(b, { account: s });
  };
  return {
    api, store, base, browser, outbox, lastCode, staffLogin, dataDir,
    advance: (ms) => { shift += ms; },
    close: async () => { await new Promise((r) => server.close(r)); store.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}
const MIN = 60000;
const person = { kind: 'b2c', name: '検証 太郎', email: 'taro@example.com', address: '東京都千代田区1-1', adult: true, agreed: true };
async function register(t, b, phone, input = person) {
  assert.equal((await b.post('/api/register/start', { phone })).status, 200);
  assert.equal((await b.post('/api/register/verify', { phone, code: t.lastCode(normalizePhone(phone)) })).status, 200);
  return b.post('/api/register/complete', input);
}

test('二段階認証は RFC 6238 の検査値と一致する', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totp(secret, 59_000), '287082');
  assert.equal(totp(secret, 1111111109_000), '081804');
  assert.equal(totp(secret, 2000000000_000), '279037');
});

test('会員登録: 電話番号 → SMS 認証 → 入力。個人は18歳以上の申告、法人は会社の項目が必須', async () => {
  const t = await setup();
  try {
    const b = t.browser();
    assert.equal((await b.post('/api/register/start', { phone: '12345' })).status, 400);
    assert.equal((await b.post('/api/register/complete', person)).status, 401, 'SMS 認証の前には登録できない');
    assert.equal((await b.post('/api/register/start', { phone: '090-1111-0001' })).status, 200);
    assert.equal((await b.post('/api/register/verify', { phone: '090-1111-0001', code: t.lastCode('09011110001') })).status, 200);
    const minor = await b.post('/api/register/complete', { ...person, adult: false });
    assert.equal(minor.status, 400);
    assert.ok(minor.json.errors.adult);
    const corp = await b.post('/api/register/complete', { ...person, kind: 'b2b' });
    assert.deepEqual(Object.keys(corp.json.errors).sort(), ['billing', 'company', 'contactName']);
    const done = await b.post('/api/register/complete', person);
    assert.equal(done.status, 200);
    assert.match(done.setCookie, /HttpOnly; SameSite=Lax/);
    const me = (await b.get('/api/me')).json;
    assert.equal(me.member.phone, '09011110001');
    assert.equal(me.member.emailVerified, false);
    assert.equal(JSON.stringify(me).includes('"id"'), false, '会員番号は画面に返さない');

    // 同じ電話番号では、もう登録できない（FR-AUTH-001）
    const again = await t.browser().post('/api/register/start', { phone: '+81 90 1111 0001' });
    assert.equal(again.status, 409);

    // メールアドレスの確認（FR-AUTH-011）
    const mail = t.outbox().find((m) => m.channel === 'email');
    const link = new URL(/https?:\/\/\S+/.exec(mail.body)[0]);
    const verified = await b.get(link.pathname + link.search);
    assert.equal(verified.status, 302);
    assert.match(verified.headers.get('location'), /email=verified/);
    assert.equal((await b.get('/api/me')).json.member.emailVerified, true);
    assert.match((await b.get(link.pathname + link.search)).headers.get('location'), /email=expired/, '同じリンクは2度使えない');
  } finally { await t.close(); }
});

test('SMS の認証番号: 5分で切れる・誤り5回で無効・同じ番号へ1時間に5回まで（FR-AUTH-004）', async () => {
  const t = await setup();
  try {
    const phone = '09011110002';
    const b = t.browser();
    // 期限
    await b.post('/api/register/start', { phone });
    const code = t.lastCode(phone);
    t.advance(5 * MIN + 1000);
    assert.equal((await b.post('/api/register/verify', { phone, code })).status, 400);
    // 誤り5回で、正しい番号も通らなくなる
    await b.post('/api/register/start', { phone });
    const code2 = t.lastCode(phone);
    const wrong = code2 === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) assert.equal((await b.post('/api/register/verify', { phone, code: wrong })).status, 400);
    const locked = await b.post('/api/register/verify', { phone, code: code2 });
    assert.equal(locked.status, 400);
    assert.equal(locked.json.resend, true);
    // 送信は1時間に5回まで（ここまでで2回）
    for (let i = 0; i < 3; i++) assert.equal((await b.post('/api/register/start', { phone })).status, 200);
    assert.equal((await b.post('/api/register/start', { phone })).status, 429);
    assert.match((await b.post('/api/register/start', { phone })).json.message, /1時間ほど待ってから/, '上限のときは、待つように案内する（スタッフが解く操作は、なくした。報告書 84 章）');
    const reception = await t.staffLogin('reception', 'uketsuke');
    assert.equal((await reception.post('/api/sms-limit/reset', { phone })).status, 404, '制限を解く窓口は、もうない');
    // 1時間たてば、また送れる
    t.advance(61 * MIN);
    assert.equal((await b.post('/api/register/start', { phone })).status, 200);
    // 使った番号は、もう使えない
    const c3 = t.lastCode(phone);
    assert.equal((await b.post('/api/register/verify', { phone, code: c3 })).status, 200);
    assert.equal((await t.browser().post('/api/register/verify', { phone, code: c3 })).status, 400);
  } finally { await t.close(); }
});

test('ログイン: 電話番号と SMS の認証番号。最後の操作から30日で切れる（FR-AUTH-005・010）', async () => {
  const t = await setup();
  try {
    const phone = '09011110003';
    assert.equal((await register(t, t.browser(), phone)).status, 200);
    const b = t.browser();
    const before = t.outbox().length;
    // 登録のない番号でも同じ返事。ただし SMS は送らない
    assert.equal((await b.post('/api/login/start', { phone: '09099990000' })).status, 200);
    assert.equal(t.outbox().length, before);
    assert.equal((await b.post('/api/login/start', { phone })).status, 200);
    assert.equal((await b.post('/api/login/verify', { phone, code: t.lastCode(phone) })).status, 200);
    assert.equal((await b.get('/api/me')).json.member.name, '検証 太郎');
    t.advance(399 * 24 * 60 * MIN);
    assert.ok((await b.get('/api/me')).json.member, '399日目は使える（ここで、最後の操作の時刻が更新される）');
    t.advance(399 * 24 * 60 * MIN);
    assert.ok((await b.get('/api/me')).json.member, '操作していれば、さらに399日たっても使える');
    t.advance(401 * 24 * 60 * MIN);
    assert.equal((await b.get('/api/me')).json.member, null);
    // ログアウト
    await b.post('/api/login/start', { phone });
    await b.post('/api/login/verify', { phone, code: t.lastCode(phone) });
    await b.post('/api/logout');
    assert.equal((await b.get('/api/me')).json.member, null);
  } finally { await t.close(); }
});

test('スタッフ（前からのログイン ID の形）: パスワード。誤り5回で15分ロック、12時間で切れる（FR-AUTH-012）', async () => {
  const t = await setup();
  try {
    const s = t.api.createStaff({ loginId: 'kanri', name: '管理 花子', role: 'admin' });
    const b = t.browser();
    const good = () => ({ loginId: 'kanri', password: s.initialPassword, code: totp(s.totpSecret) });
    assert.equal((await b.post('/api/staff/login', { ...good(), password: 'x' })).status, 401, 'パスワードが違えば入れない（認証アプリのコードは、使わなくなった）');
    assert.equal((await b.post('/api/staff/login', { ...good(), password: 'x' })).status, 401);
    for (let i = 0; i < 3; i++) await b.post('/api/staff/login', { ...good(), password: 'x' });
    assert.equal((await b.post('/api/staff/login', good())).status, 423, '5回誤ると、正しくても入れない');
    t.advance(15 * MIN + 1000);
    assert.equal((await b.post('/api/staff/login', good())).status, 200);
    assert.equal((await b.get('/api/me')).json.staff.role, 'admin');
    t.advance(12 * 60 * MIN + 1000);
    assert.equal((await b.get('/api/me')).json.staff, null);

    // パスワードの変更
    await b.post('/api/staff/login', good());
    assert.equal((await b.post('/api/staff/password', { current: s.initialPassword, next: 'short' })).status, 400);
    assert.equal((await b.post('/api/staff/password', { current: s.initialPassword, next: 'correct-horse-battery' })).status, 200);
    assert.equal((await t.browser().post('/api/staff/login', good())).status, 401);
    assert.equal((await t.browser().post('/api/staff/login', { ...good(), password: 'correct-horse-battery' })).status, 200);

    // 停止したスタッフは、その場で使えなくなる
    const other = await t.staffLogin('auctioneer', 'shinko');
    assert.equal((await b.post(`/api/staff/accounts/${other.account.id}/stop`)).status, 200);
    assert.equal((await other.get('/api/me')).json.staff, null);
    // 停止を解く（報告書 80 章）。停止の前のパスワードで、またログインできる
    assert.equal((await t.browser().post(`/api/staff/accounts/${other.account.id}/reactivate`)).status, 401, 'ログインしていない人は、解けない');
    assert.equal((await b.post(`/api/staff/accounts/${other.account.id}/reactivate`)).status, 200);
    assert.equal((await b.post(`/api/staff/accounts/${other.account.id}/reactivate`)).status, 409, '停止していないスタッフは、解けない');
    assert.equal((await b.get('/api/staff/accounts')).json.staff.find((x) => x.id === other.account.id).active, true);
    // 秘密は一覧に出ない
    const list = JSON.stringify((await b.get('/api/staff/accounts')).json);
    assert.equal(/password|totp|secret/i.test(list), false);
  } finally { await t.close(); }
});

test('AC-FR-AUTH-013-1: スタッフの電話番号では会員登録できない。会員の番号ではスタッフを作れない', async () => {
  const t = await setup();
  try {
    const admin = await t.staffLogin('admin', 'kanri', '090-2222-0001');
    const r = await t.browser().post('/api/register/start', { phone: '09022220001' });
    assert.equal(r.status, 409);
    assert.equal(t.outbox().length, 0, 'SMS も送らない');
    await register(t, t.browser(), '09022220002');
    const made = await admin.post('/api/staff/accounts', { loginId: 'uketsuke', name: '受付', role: 'reception', phone: '09022220002' });
    assert.equal(made.status, 409);
  } finally { await t.close(); }
});

test('権限はサーバーで確かめる（8.14）: 会員・受付係・進行役にできないこと', async () => {
  const t = await setup();
  try {
    const admin = await t.staffLogin('admin', 'kanri');
    const auctioneer = await t.staffLogin('auctioneer', 'shinko');
    const reception = await t.staffLogin('reception', 'uketsuke');
    const member = t.browser();
    await register(t, member, '09033330001');
    const anon = t.browser();
    for (const [who, b, status] of [['未ログイン', anon, 401], ['会員', member, 401], ['受付係', reception, 403]]) {
      assert.equal((await b.get('/api/events')).status, status, `${who}: 開催の一覧`);
      assert.equal((await b.get('/api/members')).status, status, `${who}: 会員の一覧`);
      assert.equal((await b.post('/api/settings', {})).status, status, `${who}: 設定の変更`);
    }
    // 事前の商品登録・審査・カタログは持たない（商品は、進行コンソールからその場で登録する）
    for (const url of ['/api/items', '/api/catalog', '/uploads/x.png']) assert.equal((await admin.get(url)).status, 404, url);
    assert.equal((await anon.get('/api/terms')).json.shippingNotice.includes('送料'), true, '送料・返品の表示は、だれでも見られる');
    for (const url of ['/api/members', '/api/staff/accounts', '/api/audit', '/api/settings']) {
      assert.equal((await auctioneer.get(url)).status, 403, `進行役: ${url}`);
    }
    assert.equal((await auctioneer.post('/api/events', {})).status, 403);
    assert.equal((await auctioneer.post('/api/members/1/suspend', { reason: 'x' })).status, 403);
    // 主催者管理者は、理由を添えて会員を停止できる（FR-AUTH-009）
    assert.equal((await admin.post('/api/members/1/suspend', {})).status, 400);
    assert.equal((await admin.post('/api/members/1/suspend', { reason: '支払いの遅れ' })).status, 200);
    assert.equal((await member.get('/api/me')).json.member.suspended, true);
    assert.equal((await admin.post('/api/members/1/unsuspend')).status, 200);
    // よそのサイトのページからの送信は断る
    assert.equal((await admin.post('/api/members/1/suspend', { reason: 'x' }, { origin: 'https://evil.example' })).status, 403);
    // JSON 以外は受け取らない
    assert.equal((await admin.post('/api/members/1/suspend', Buffer.from('reason=x'), { 'content-type': 'text/plain' })).status, 415);
  } finally { await t.close(); }
});

test('開催: 届出済みの印がないと公開できない（FR-EVT-002）', async () => {
  const t = await setup();
  try {
    const admin = await t.staffLogin('admin', 'kanri');
    const ev = { title: '12月の競り', startsAt: '2026-12-05T09:00', endsAt: '2026-12-05T16:00', venueName: '検証会場', venueAddress: '埼玉県◯◯市1-2-3' };
    assert.equal((await admin.post('/api/events', { ...ev, endsAt: '2026-12-05T08:00' })).status, 400);
    const { id } = (await admin.post('/api/events', ev)).json;
    assert.equal((await admin.post(`/api/events/${id}/publish`)).status, 409);
    assert.equal((await admin.post(`/api/events/${id}`, { ...ev, notified: true })).status, 200);
    assert.equal((await admin.post(`/api/events/${id}/publish`)).status, 200);
    assert.equal((await admin.get('/api/events')).json.events[0].status, 'published');
    // 印を外すと、公開も取り下げる
    await admin.post(`/api/events/${id}`, { ...ev, notified: false });
    assert.equal((await admin.get('/api/events')).json.events[0].status, 'preparing');
  } finally { await t.close(); }
});

test('監査ログ: 誰が・いつ・何を・前後の値を残す。消せない・直せない（DATA-001）', async () => {
  const t = await setup();
  try {
    const admin = await t.staffLogin('admin', 'kanri');
    await register(t, t.browser(), '09044440001');
    await admin.post('/api/members/1/suspend', { reason: '検証' });
    const entries = (await admin.get('/api/audit')).json.entries;
    const e = entries.find((x) => x.type === 'member.suspend');
    assert.equal(e.actor_kind, 'staff');
    assert.equal(e.actor_role, 'admin');
    assert.equal(e.reason, '検証');
    assert.deepEqual(JSON.parse(e.after), { suspended: true });
    assert.ok(entries.some((x) => x.type === 'member.register'));
    assert.equal(/09044440001|\d{6}です/.test(JSON.stringify(entries)), false, '電話番号や認証番号を、監査ログに書かない');
    assert.throws(() => t.store.db.prepare("UPDATE audit_log SET reason = 'x'").run(), /追記だけ/);
    assert.throws(() => t.store.db.prepare('DELETE FROM audit_log').run(), /追記だけ/);
  } finally { await t.close(); }
});

test('認証の試行の上限: 同じ接続元から1分あたりの回数を超えると断る', async () => {
  const t = await setup({ POC_AUTH_RATE: '3' });
  try {
    const b = t.browser();
    for (let i = 0; i < 3; i++) assert.equal((await b.post('/api/staff/login', { loginId: 'nobody', password: 'x', code: '000000' })).status, 401);
    assert.equal((await b.post('/api/staff/login', { loginId: 'nobody', password: 'x', code: '000000' })).status, 429);
    t.advance(MIN + 1000);
    assert.equal((await b.post('/api/staff/login', { loginId: 'nobody', password: 'x', code: '000000' })).status, 401);
  } finally { await t.close(); }
});

test('その場での登録（進行コンソール）: 登録を監査ログに残す', async () => {
  const { makeEnv, startServer, connect, cleanup } = await import('./helpers.js');
  const ctx = makeEnv();
  const srv = await startServer(ctx);
  try {
    const a = await connect(srv, ctx.tokens.auctioneer);
    assert.equal((await a.cmd('create_lot', { title: '飯ごう', startPrice: 1000 })).ok, true);
    await srv.stop();
    const db = openDb(path.join(ctx.dataDir, 'auction.db'));
    const rows = db.db.prepare("SELECT * FROM audit_log WHERE type = 'lot.create'").all();
    db.db.close();
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].after).title, '飯ごう');
  } finally { await srv.stop().catch(() => {}); cleanup(ctx); }
});

test('メールアドレスでもログインできる（確認済みのアドレスだけ。大文字と小文字は区別しない）', async () => {
  const t = await setup();
  try {
    const phone = '09011113333';
    assert.equal((await register(t, t.browser(), phone)).status, 200);
    const b = t.browser();
    const mails = () => t.outbox().filter((m) => m.channel === 'email' && m.to === 'taro@example.com');
    const codeOf = () => /認証番号は (\d{6})/.exec(mails().at(-1).body)[1];
    // 確認が済んでいないアドレスには、送らない（返事は同じ）
    const before = mails().length;
    const cold = await b.post('/api/login/start', { id: 'taro@example.com' });
    assert.deepEqual([cold.status, cold.json.via], [200, 'email']);
    assert.equal(mails().length, before);
    // 確認のリンクを開くと、メールでログインできる
    const token = /token=([\w-]+)/.exec(mails().at(-1).body)[1];
    await t.browser().get(`/api/email/verify?token=${token}`);
    assert.equal((await b.post('/api/login/start', { id: 'Taro@Example.com' })).status, 200);
    assert.equal(mails().length, before + 1);
    assert.equal((await b.post('/api/login/verify', { id: 'taro@example.com', code: '000000' === codeOf() ? '111111' : '000000' })).status, 400);
    assert.equal((await b.post('/api/login/verify', { id: 'Taro@Example.com', code: codeOf() })).status, 200);
    assert.equal((await b.get('/api/me')).json.member.phone, phone);
    // 登録のないアドレス・形のおかしい入力
    assert.equal((await b.post('/api/login/start', { id: 'nobody@example.com' })).status, 200);
    assert.equal((await b.post('/api/login/start', { id: 'abc' })).status, 400);
  } finally { await t.close(); }
});

test('会員登録: 姓名・フリガナ・郵便番号つきの住所を分けて受ける。郵便番号から住所が引ける', async () => {
  const t = await setup();
  try {
    const b = t.browser();
    const zip = await b.get('/api/postal?code=100-0001');
    assert.deepEqual(zip.json.results[0], { prefecture: '東京都', city: '千代田区', town: '千代田' });
    assert.equal((await b.get('/api/postal?code=123')).status, 400);
    assert.deepEqual((await b.get('/api/postal?code=9999999')).json.results, []);
    const input = { kind: 'b2c', lastName: '山田', firstName: '太郎', lastKana: 'やまだ', firstKana: 'タロウ', email: 'y@example.com',
      postalCode: '１００-0001', prefecture: '東京都', address1: '千代田区千代田1-1', address2: '○○ビル 3階', adult: true, agreed: true };
    const bad = await register(t, b, '09011114444', { ...input, lastKana: '山田', postalCode: '123', prefecture: '江戸', address1: '千代田区' });
    assert.deepEqual(Object.keys(bad.json.errors).sort(), ['address1', 'lastKana', 'postalCode', 'prefecture']);
    const done = await b.post('/api/register/complete', input);
    assert.equal(done.status, 200);
    const m = done.json.member;
    assert.deepEqual([m.name, m.nameKana, m.postalCode, m.address], ['山田 太郎', 'ヤマダ タロウ', '1000001', '〒100-0001 東京都千代田区千代田1-1 ○○ビル 3階']);
  } finally { await t.close(); }
});

test('メールアドレスでも会員登録を始められる（電話番号は、未確認として入れる）', async () => {
  const t = await setup();
  try {
    const b = t.browser();
    const mails = (to) => t.outbox().filter((m) => m.channel === 'email' && m.to === to);
    const start = await b.post('/api/register/start', { id: 'Hana@Example.com' });
    assert.deepEqual([start.status, start.json.via], [200, 'email']);
    const code = /認証番号は (\d{6})/.exec(mails('hana@example.com').at(-1).body)[1];
    assert.equal((await b.post('/api/register/verify', { id: 'hana@example.com', code })).status, 200);
    assert.deepEqual([(await b.get('/api/me')).json.registerVia, (await b.get('/api/me')).json.registerId], ['email', 'hana@example.com']);
    // 電話番号が要る。ほかの会員・スタッフの番号は使えない
    assert.ok((await b.post('/api/register/complete', { ...person, phone: '' })).json.errors.phone);
    assert.equal((await register(t, t.browser(), '09022220001')).status, 200);
    assert.ok((await b.post('/api/register/complete', { ...person, phone: '090-2222-0001' })).json.errors.phone);
    const sent = mails('hana@example.com').length;
    const done = await b.post('/api/register/complete', { ...person, email: 'ignored@example.com', phone: '090-2222-0002' });
    assert.equal(done.status, 200);
    const m = done.json.member;
    assert.deepEqual([m.email, m.emailVerified, m.phone, m.phoneVerified], ['hana@example.com', true, '09022220002', false]);
    assert.equal(mails('hana@example.com').length, sent, '確認済みなので、確認のメールは送らない');
    // 未確認の電話番号では、SMS のログインができない（返事は同じ）。メールでは入れる
    const smsBefore = t.outbox().filter((x) => x.channel === 'sms').length;
    assert.equal((await t.browser().post('/api/login/start', { id: '09022220002' })).status, 200);
    assert.equal(t.outbox().filter((x) => x.channel === 'sms').length, smsBefore);
    const c = t.browser();
    await c.post('/api/login/start', { id: 'hana@example.com' });
    const code2 = /認証番号は (\d{6})/.exec(mails('hana@example.com').at(-1).body)[1];
    assert.equal((await c.post('/api/login/verify', { id: 'hana@example.com', code: code2 })).status, 200);
    // 登録済み（確認済み）のアドレスでは、登録を始められない
    const again = await t.browser().post('/api/register/start', { id: 'hana@example.com' });
    assert.deepEqual([again.status, again.json.login], [409, true]);
  } finally { await t.close(); }
});

test('会員登録は承認待ちになり、主催者管理者が承認すると、ログイン ID とパスワードがメールで届く。それでログインできる', async () => {
  const t = await setup({ POC_AUTO_APPROVE: '0' });
  try {
    const admin = await t.staffLogin('admin', 'kanri', null);
    const b = t.browser();
    const phone = '09033330001';
    const done = await register(t, b, phone);
    assert.deepEqual([done.status, done.json.pending], [200, true]);
    assert.equal((await b.get('/api/me')).json.member, null, '承認待ちのあいだは、ログインしていない');
    // 承認の前は、認証番号でのログインも、できない（返事は同じ。SMS は送らない）
    const sms = () => t.outbox().filter((m) => m.channel === 'sms').length;
    const before = sms();
    assert.equal((await t.browser().post('/api/login/start', { id: phone })).status, 200);
    assert.equal(sms(), before);
    // 一覧に「承認待ち」で出る。主催者管理者だけが承認できる
    const list = (await admin.get('/api/members')).json.members;
    assert.deepEqual([list[0].approved, list[0].loginId], [false, null]);
    const id = list[0].id;
    assert.equal((await b.post(`/api/members/${id}/approve`)).status, 401);
    const ok = await admin.post(`/api/members/${id}/approve`);
    assert.equal(ok.status, 200);
    assert.match(ok.json.loginId, /^rw\d{5}$/);
    assert.equal(ok.json.devPassword, undefined, 'お試し用の設定でなければ、パスワードは画面に返さない');
    assert.equal((await admin.post(`/api/members/${id}/approve`)).status, 409);
    // 承認のメールに、ログイン ID とパスワードが書いてある
    const mail = t.outbox().filter((m) => m.channel === 'email' && m.to === 'taro@example.com' && /承認しました/.test(m.subject)).at(-1);
    const loginId = /ログイン ID: (\S+)/.exec(mail.body)[1], password = /パスワード: (\S+)/.exec(mail.body)[1];
    assert.equal(loginId, ok.json.loginId);
    // ログイン: 誤りは、どちらが違うかを言わない
    const c = t.browser();
    const ng = await c.post('/api/login/password', { loginId, password: 'chigau-password' });
    assert.deepEqual([ng.status, ng.json.message], [401, 'ログイン ID かパスワードが違います']);
    assert.equal((await c.post('/api/login/password', { loginId: 'inai', password })).json.message, 'ログイン ID かパスワードが違います');
    const inn = await c.post('/api/login/password', { loginId: loginId.toUpperCase(), password });
    assert.equal(inn.status, 200);
    assert.match(inn.setCookie, /Max-Age=34560000/, '一度ログインしたら、400日は求めない');
    // 発行するパスワードは、見まちがえやすい字と記号を使わない。写し取ったときの前後の空白と、全角で打った ID は、受ける
    assert.match(password, /^[a-hjkmnp-z2-9]{12}$/);
    const fw = loginId.replace(/[a-z0-9]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));
    assert.equal((await t.browser().post('/api/login/password', { loginId: ` ${fw}　`, password: `  ${password}\n` })).status, 200);
    assert.equal((await t.browser().post('/api/login/password', { loginId, password: password.slice(0, -1) })).status, 401);
    assert.equal((await c.get('/api/me')).json.member.loginId, loginId);
    // パスワードの変更: いまのパスワードが要る。変えると、新しいほうでだけ入れる
    assert.ok((await c.post('/api/my/credentials', { loginId, password: 'atarashii-pass-1', currentPassword: 'x' })).json.errors.currentPassword);
    assert.ok((await c.post('/api/my/credentials', { loginId, password: 'short', currentPassword: password })).json.errors.password);
    assert.equal((await c.post('/api/my/credentials', { loginId, password: 'atarashii-pass-1', currentPassword: password })).status, 200);
    assert.equal((await t.browser().post('/api/login/password', { loginId, password })).status, 401);
    assert.equal((await t.browser().post('/api/login/password', { loginId, password: 'atarashii-pass-1' })).status, 200);
    // 誤りが 10 回続くと、しばらく止まる
    const d = t.browser();
    for (let i = 0; i < 10; i++) await d.post('/api/login/password', { loginId, password: 'ng' });
    assert.equal((await d.post('/api/login/password', { loginId, password: 'atarashii-pass-1' })).status, 423);
    // 主催者管理者の再発行で、また入れる
    const again = await admin.post(`/api/members/${id}/credentials`);
    assert.equal(again.status, 200);
    const mail2 = t.outbox().filter((m) => m.channel === 'email' && /お知らせ/.test(m.subject)).at(-1);
    assert.equal((await t.browser().post('/api/login/password', { loginId, password: /パスワード: (\S+)/.exec(mail2.body)[1] })).status, 200);
  } finally { await t.close(); }
});

test('会員登録を承認しないと、電話番号が空き、もう一度申し込める', async () => {
  const t = await setup({ POC_AUTO_APPROVE: '0' });
  try {
    const admin = await t.staffLogin('admin', 'kanri', null);
    const phone = '09033330002';
    await register(t, t.browser(), phone);
    const id = (await admin.get('/api/members')).json.members[0].id;
    assert.equal((await admin.post(`/api/members/${id}/reject`, {})).status, 400, '理由が要る');
    assert.equal((await admin.post(`/api/members/${id}/reject`, { reason: '重複の申し込み' })).status, 200);
    assert.equal((await admin.get('/api/members')).json.members[0].rejected, true);
    assert.ok(t.outbox().some((m) => m.channel === 'email' && /お受けできませんでした/.test(m.body)));
    assert.equal((await register(t, t.browser(), phone)).json.pending, true, '同じ番号で、もう一度申し込める');
  } finally { await t.close(); }
});

test('スタッフ: 主催者管理者がメールアドレスを登録する。本人は、最初のログインで、パスワードを決める（確認コードは無い）', async () => {
  const t = await setup();
  try {
    const admin = await t.staffLogin('admin', 'kanri', null);
    const made = await admin.post('/api/staff/accounts', { email: 'Uketsuke@Example.com', name: '受付 太郎', role: 'reception' });
    assert.equal(made.status, 200);
    assert.equal(made.json.email, 'uketsuke@example.com');
    assert.equal(made.json.setupCode, undefined);
    assert.equal((await admin.post('/api/staff/accounts', { email: 'uketsuke@example.com', name: '二重', role: 'reception' })).status, 409);
    assert.equal((await admin.post('/api/staff/accounts', { email: 'x', name: 'x', role: 'reception' })).status, 400);
    const mail = t.outbox().filter((m) => m.channel === 'email' && m.to === 'uketsuke@example.com').at(-1);
    assert.match(mail.body, /はじめての方/);
    assert.doesNotMatch(mail.body, /確認コード/);
    const row = () => t.store.db.prepare('SELECT * FROM staff_accounts WHERE email = ?').get('uketsuke@example.com');
    assert.equal(row().password_hash, '');
    const b = t.browser();
    // パスワードを決める前は、ログインできない。登録の無いメールアドレスでは、決められない
    assert.equal((await b.post('/api/staff/login', { email: 'uketsuke@example.com', password: '' })).status, 401);
    assert.equal((await b.post('/api/staff/setup', { email: 'shiranai@example.com', password: 'tadashii-password-1' })).status, 401);
    assert.ok((await b.post('/api/staff/setup', { email: 'uketsuke@example.com', password: 'short' })).json.errors.password);
    const ok = await b.post('/api/staff/setup', { email: 'UKETSUKE@example.com', password: 'tadashii-password-1' });
    assert.equal(ok.status, 200);
    assert.equal((await b.get('/api/me')).json.staff.role, 'reception');
    assert.ok(row().password_hash.length > 40 && !row().password_hash.includes('tadashii-password-1'), 'パスワードは、ハッシュで保存する');
    // 決めたあとは、もう決め直せない（他人が、上書きできない）
    assert.equal((await t.browser().post('/api/staff/setup', { email: 'uketsuke@example.com', password: 'betsuno-password-2' })).status, 401);
    // 次からは、メールアドレスとパスワード
    assert.equal((await t.browser().post('/api/staff/login', { email: 'uketsuke@example.com', password: 'chigau' })).status, 401);
    assert.equal((await t.browser().post('/api/staff/login', { email: 'Uketsuke@example.com', password: 'tadashii-password-1' })).status, 200);
    // 決め直し: パスワードが消え、それまでのログインは切れる。本人が、もう一度決める
    const id = (await admin.get('/api/staff/accounts')).json.staff.find((x) => x.email === 'uketsuke@example.com').id;
    const reset = await admin.post(`/api/staff/accounts/${id}/reset`);
    assert.equal(reset.status, 200);
    assert.equal((await b.get('/api/me')).json.staff, null);
    assert.equal((await t.browser().post('/api/staff/login', { email: 'uketsuke@example.com', password: 'tadashii-password-1' })).status, 401);
    assert.equal((await t.browser().post('/api/staff/setup', { email: 'uketsuke@example.com', password: 'atarashii-password-3' })).status, 200);
    // 決められる期限は 7 日
    await admin.post('/api/staff/accounts', { email: 'osoi@example.com', name: '遅い', role: 'operator' });
    t.advance(8 * 24 * 60 * MIN);
    assert.equal((await t.browser().post('/api/staff/setup', { email: 'osoi@example.com', password: 'tadashii-password-1' })).status, 401);
  } finally { await t.close(); }
});

test('スタッフ: 設定にあるメールアドレス（ハッシュ）の人は、最初のログインで、主催者管理者として登録される（1回だけ）', async () => {
  const hash = crypto.createHash('sha256').update('saisho@example.com').digest('hex');
  const t = await setup({ POC_ADMIN_EMAIL_SHA256: hash });
  try {
    assert.equal((await t.browser().post('/api/staff/setup', { email: 'chigau@example.com', password: 'tadashii-password-1' })).status, 401);
    const b = t.browser();
    assert.equal((await b.post('/api/staff/setup', { email: 'Saisho@Example.com', password: 'tadashii-password-1' })).status, 200);
    assert.equal((await b.get('/api/me')).json.staff.role, 'admin');
    // 2回目は、通らない（すでに決めてある）
    assert.equal((await t.browser().post('/api/staff/setup', { email: 'saisho@example.com', password: 'nottori-password-9' })).status, 401);
    assert.equal((await t.browser().post('/api/staff/login', { email: 'saisho@example.com', password: 'tadashii-password-1' })).status, 200);
  } finally { await t.close(); }
});

test('SMS を使わない設定では、登録と「パスワードを忘れた方」は、メールアドレスだけ', async () => {
  const t = await setup({ POC_SMS: '0' });
  try {
    assert.equal((await t.browser().get('/api/terms')).json.sms, false);
    const r = await t.browser().post('/api/register/start', { id: '09011112222' });
    assert.equal(r.status, 400);
    assert.match(r.json.message, /メールアドレス/);
    assert.equal((await t.browser().post('/api/login/start', { id: '09011112222' })).status, 400);
    assert.equal((await t.browser().post('/api/register/start', { id: 'mail-only@example.com' })).status, 200);
    assert.ok(!t.outbox().some((m) => m.channel === 'sms'));
  } finally { await t.close(); }
});

test('メールアドレスの主催者管理者ができたあとは、設定のメールアドレスでの登録の道は、閉じる', async () => {
  const hash = crypto.createHash('sha256').update('saisho@example.com').digest('hex');
  const t = await setup({ POC_ADMIN_EMAIL_SHA256: hash });
  try {
    const admin = await t.staffLogin('admin', 'kanri', null);
    assert.equal((await admin.post('/api/staff/accounts', { email: 'betsu@example.com', name: '別の管理者', role: 'admin' })).status, 200);
    assert.equal((await t.browser().post('/api/staff/setup', { email: 'saisho@example.com', password: 'tadashii-password-1' })).status, 401);
  } finally { await t.close(); }
});

test('個人情報の保存期間: 退会でログインの情報をすぐ消し、取引のない退会は1年で氏名・連絡先を消す。監査ログは接続元だけを1年で消せる（本番運用の評価 C。報告書 110 章）', async () => {
  const t = await setup();
  try {
    const b = t.browser();
    assert.equal((await register(t, b, '090-1111-0201')).status, 200);
    const db = t.store.db;
    const id = db.prepare("SELECT id FROM member_accounts WHERE phone = '09011110201'").get().id;
    db.prepare("UPDATE member_accounts SET password_hash = 'x', login_id = 'rw1', event_mail_consent_at = 1, unsub_token = 'tok' WHERE id = ?").run(id);
    // ログイン（認証番号）は監査ログに残る
    const c = t.browser();
    await c.post('/api/login/start', { id: '090-1111-0201' });
    assert.equal((await c.post('/api/login/verify', { id: '090-1111-0201', code: t.lastCode('09011110201') })).status, 200);
    assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE type = 'member.login' AND target = ?").get(`member:${id}`));
    assert.equal((await b.post('/api/my/withdraw')).status, 200);
    let m = db.prepare('SELECT * FROM member_accounts WHERE id = ?').get(id);
    assert.deepEqual([m.password_hash, m.login_id, m.event_mail_consent_at, m.unsub_token], [null, null, null, null], '退会で、ログインの情報と同意をすぐ消す');
    assert.equal(m.name, '検証 太郎', '氏名は、保存期間のあいだ残す');
    assert.equal(t.api.purgeExpiredPii().members, 0);
    t.advance(366 * 24 * 60 * MIN);
    assert.equal(t.api.purgeExpiredPii().members, 1);
    m = db.prepare('SELECT * FROM member_accounts WHERE id = ?').get(id);
    assert.deepEqual([m.name, m.email, m.address, m.withdrawn_phone], ['（削除済み）', '', '', null]);
    assert.ok(m.pii_purged_at);
    assert.equal(t.api.purgeExpiredPii().members, 0, '2度は消さない');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE ip IS NOT NULL AND at < ?').get(Date.now()).n, 0, '1年を過ぎた接続元は消える');
    // 監査ログ: 接続元を消すほかの書き換え・削除はできない
    assert.throws(() => db.prepare("UPDATE audit_log SET type = 'x' WHERE id = 1").run(), /追記だけ/);
    assert.throws(() => db.prepare('UPDATE audit_log SET ip = NULL, reason = 1 WHERE id = 1').run(), /追記だけ/);
    assert.throws(() => db.prepare('DELETE FROM audit_log WHERE id = 1').run(), /追記だけ/);
  } finally { await t.close(); }
});
