// MVP の 1（会員登録・認証・スタッフ）と 2（商品登録・カタログ・審査）。
// 時刻を進められるように、API を同じプロセスの中で立てて確かめる。データはすべて架空のもの。
import test from 'node:test';
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
  const config = loadConfig({ POC_DATA_DIR: dataDir, POC_AUTH_RATE: '0', ...env });
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
const person = { kind: 'b2c', name: '検証 太郎', email: 'taro@example.com', address: '東京都千代田区1-1', adult: true };
async function register(t, b, phone, input = person) {
  assert.equal((await b.post('/api/register/start', { phone })).status, 200);
  assert.equal((await b.post('/api/register/verify', { phone, code: t.lastCode(normalizePhone(phone)) })).status, 200);
  return b.post('/api/register/complete', input);
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const item = { title: '防水シート', description: '訓練で使われたもの', quantity: 1, startPrice: 3000, size: '2m×3m', condition: '小さな破れあり', surplusInfo: '' };

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
    // スタッフが制限を解ける（受付係でもよい）
    const reception = await t.staffLogin('reception', 'uketsuke');
    assert.equal((await reception.post('/api/sms-limit/reset', { phone })).status, 200);
    assert.equal((await b.post('/api/register/start', { phone })).status, 200);
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
    t.advance(29 * 24 * 60 * MIN);
    assert.ok((await b.get('/api/me')).json.member, '29日目は使える（ここで、最後の操作の時刻が更新される）');
    t.advance(29 * 24 * 60 * MIN);
    assert.ok((await b.get('/api/me')).json.member, '操作していれば、さらに29日たっても使える');
    t.advance(31 * 24 * 60 * MIN);
    assert.equal((await b.get('/api/me')).json.member, null);
    // ログアウト
    await b.post('/api/login/start', { phone });
    await b.post('/api/login/verify', { phone, code: t.lastCode(phone) });
    await b.post('/api/logout');
    assert.equal((await b.get('/api/me')).json.member, null);
  } finally { await t.close(); }
});

test('スタッフ: ID・パスワード・二段階認証。誤り5回で15分ロック、12時間で切れる（FR-AUTH-012）', async () => {
  const t = await setup();
  try {
    const s = t.api.createStaff({ loginId: 'kanri', name: '管理 花子', role: 'admin' });
    const b = t.browser();
    const good = () => ({ loginId: 'kanri', password: s.initialPassword, code: totp(s.totpSecret) });
    assert.equal((await b.post('/api/staff/login', { ...good(), code: '000000' === totp(s.totpSecret) ? '111111' : '000000' })).status, 401, '二段階認証が違えば入れない');
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
      assert.equal((await b.get('/api/items')).status, status, `${who}: 商品の一覧`);
      assert.equal((await b.post('/api/items', item)).status, status, `${who}: 商品の登録`);
      assert.equal((await b.get('/api/members')).status, status, `${who}: 会員の一覧`);
    }
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
    assert.equal((await t.browser().get('/api/catalog')).json.events.length, 1);
    // 印を外すと、公開も取り下げる
    await admin.post(`/api/events/${id}`, { ...ev, notified: false });
    assert.equal((await t.browser().get('/api/catalog')).json.events.length, 0);
  } finally { await t.close(); }
});

test('商品: 登録 → 審査 → カタログ。AC-FR-ITEM-005-1（登録した人は承認できない）、AC-FR-ITEM-008-1（承認後の変更で審査待ちに戻る）', async () => {
  const t = await setup();
  try {
    const admin = await t.staffLogin('admin', 'kanri');
    const auctioneer = await t.staffLogin('auctioneer', 'shinko');
    const ev = { title: '12月の競り', startsAt: '2026-12-05T09:00', endsAt: '2026-12-05T16:00', venueName: '検証会場', venueAddress: '埼玉県◯◯市1-2-3', notified: true };
    const eventId = (await admin.post('/api/events', ev)).json.id;
    await admin.post(`/api/events/${eventId}/publish`);

    // 入力の検査
    const badItem = await auctioneer.post('/api/items', { ...item, title: '', startPrice: 0, reservePrice: 100 });
    assert.deepEqual(Object.keys(badItem.json.errors).sort(), ['startPrice', 'title']);
    assert.ok((await auctioneer.post('/api/items', { ...item, reservePrice: 3200 })).json.errors.reservePrice, '最低落札額は、入札できる金額に合わせる');

    const { id } = (await auctioneer.post('/api/items', { ...item, eventId, sortOrder: 2, reservePrice: 5000 })).json;
    const second = (await admin.post('/api/items', { ...item, title: '飯ごう', eventId, sortOrder: 1 })).json.id;
    const catalog = async () => (await t.browser().get('/api/catalog')).json.events[0].items;
    assert.equal((await catalog()).length, 0, '承認の前は、カタログに出ない');

    assert.equal((await auctioneer.post(`/api/items/${id}/review`, { decision: 'approved' })).status, 409, '審査に出す前は審査できない');
    await auctioneer.post(`/api/items/${id}/submit`);
    assert.equal((await auctioneer.post(`/api/items/${id}/review`, { decision: 'approved' })).status, 403, '登録した人は承認できない');
    assert.equal((await admin.post(`/api/items/${id}/review`, { decision: 'rejected' })).status, 400, '却下には理由が要る');
    assert.equal((await admin.post(`/api/items/${id}/review`, { decision: 'approved' })).status, 200);
    await admin.post(`/api/items/${second}/submit`);
    await auctioneer.post(`/api/items/${second}/review`, { decision: 'approved' });

    const shown = await catalog();
    assert.deepEqual(shown.map((i) => [i.no, i.title]), [[1, '飯ごう'], [2, '防水シート']], '出品順に、No. を1から振る');
    assert.equal(/reserve|5000|status|createdBy/.test(JSON.stringify(shown)), false, '最低落札額と内部の情報は、カタログに出さない');

    // 出品順だけの変更では、承認は保たれる
    assert.equal((await auctioneer.post(`/api/items/${id}`, { ...item, eventId, sortOrder: 0, reservePrice: 5000 })).json.status, 'approved');
    // 内容の変更で、審査待ちに戻り、カタログから消える
    assert.equal((await auctioneer.post(`/api/items/${id}`, { ...item, description: '書き足した説明', eventId, reservePrice: 5000 })).json.status, 'pending');
    assert.deepEqual((await catalog()).map((i) => i.title), ['飯ごう']);
    // 変えた人は、承認できない
    assert.equal((await auctioneer.post(`/api/items/${id}/review`, { decision: 'approved' })).status, 403);
    assert.equal((await admin.post(`/api/items/${id}/review`, { decision: 'approved' })).status, 200);
    const reviews = (await admin.get(`/api/items/${id}/reviews`)).json.reviews;
    assert.equal(reviews.length, 2);
    // 審査の記録は、消せない・直せない
    assert.throws(() => t.store.db.prepare('DELETE FROM item_reviews').run(), /追記だけ/);
  } finally { await t.close(); }
});

test('出品禁止の言葉: 警告が出た商品は、理由がないと承認できない（FR-ITEM-006・007）', async () => {
  const t = await setup();
  try {
    const admin = await t.staffLogin('admin', 'kanri');
    const auctioneer = await t.staffLogin('auctioneer', 'shinko');
    assert.equal((await admin.post('/api/settings', { orgName: '株式会社NEWS', returnPolicy: '仮', shippingNotice: '仮', bannedWords: ['実銃', ' '] })).status, 200);
    const { id } = (await auctioneer.post('/api/items', { ...item, description: '実銃ではなく模型' })).json;
    assert.deepEqual((await admin.get('/api/items')).json.items[0].warnings, ['実銃']);
    await auctioneer.post(`/api/items/${id}/submit`);
    const noReason = await admin.post(`/api/items/${id}/review`, { decision: 'approved' });
    assert.equal(noReason.status, 400);
    assert.deepEqual(noReason.json.warnings, ['実銃']);
    assert.equal((await admin.post(`/api/items/${id}/review`, { decision: 'approved', reason: '模型であることを現物で確かめた' })).status, 200);
    const review = (await admin.get(`/api/items/${id}/reviews`)).json.reviews[0];
    assert.deepEqual(review.warnings, ['実銃']);
    assert.equal(review.reason, '模型であることを現物で確かめた');
  } finally { await t.close(); }
});

test('写真: JPEG・PNG・WebP だけ、1枚 10MB まで、1商品 20 枚まで。公開前の写真は外から見えない（FR-ITEM-002）', async () => {
  const t = await setup();
  try {
    const admin = await t.staffLogin('admin', 'kanri');
    const auctioneer = await t.staffLogin('auctioneer', 'shinko');
    const { id } = (await auctioneer.post('/api/items', item)).json;
    const up = (buf) => auctioneer.post(`/api/items/${id}/photos`, buf, { 'content-type': 'application/octet-stream' });
    assert.equal((await up(Buffer.from('<svg onload=alert(1)>'))).status, 400, '中身が画像でなければ断る');
    assert.equal((await up(Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]))).status, 413);
    const ok = await up(PNG);
    assert.equal(ok.status, 200);
    const url = ok.json.photos[0].url;
    assert.equal((await t.browser().get(url)).status, 404, '承認・公開の前は、外から見えない');
    const seen = await auctioneer.get(url);
    assert.equal(seen.status, 200);
    assert.equal(seen.headers.get('content-type'), 'image/png');
    for (let i = 1; i < 20; i++) assert.equal((await up(PNG)).status, 200);
    assert.equal((await up(PNG)).status, 400, '21枚目は断る');
    // 承認の後に写真を足すと、審査待ちに戻る
    const pid = ok.json.photos[0].id;
    await auctioneer.post(`/api/items/${id}/submit`);
    await admin.post(`/api/items/${id}/review`, { decision: 'approved' });
    assert.equal((await auctioneer.post(`/api/photos/${pid}/delete`)).status, 200);
    assert.equal((await admin.get('/api/items')).json.items[0].status, 'pending');
    assert.equal((await auctioneer.get(url)).status, 404);
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

test('その場での登録（進行コンソール）: 出品禁止の言葉が品名にあれば理由を求め、登録を記録に残す', async () => {
  const { makeEnv, startServer, connect, cleanup } = await import('./helpers.js');
  const ctx = makeEnv();
  // 出品禁止の言葉を、あらかじめ設定しておく
  const store = openDb(path.join(ctx.dataDir, 'auction.db'));
  createApi({ store, config: loadConfig(ctx.env), nowMs: () => Date.now() });
  store.db.prepare("UPDATE settings SET value = ? WHERE key = 'banned_words'").run(JSON.stringify(['実銃']));
  store.db.close();
  const srv = await startServer(ctx);
  try {
    const a = await connect(srv, ctx.tokens.auctioneer);
    assert.equal((await a.cmd('create_lot', { title: '飯ごう', startPrice: 1000 })).ok, true, '言葉が含まれなければ、そのまま登録できる');
    const refused = await a.cmd('create_lot', { title: '実銃の模型', startPrice: 1000 });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'BANNED_WORD');
    assert.deepEqual(refused.words, ['実銃']);
    assert.equal((await a.cmd('create_lot', { title: '実銃の模型', startPrice: 1000, reason: '模型であることを現物で確かめた' })).ok, true);
    a.close?.();
    await srv.stop();
    const db = openDb(path.join(ctx.dataDir, 'auction.db'));
    const rows = db.db.prepare("SELECT * FROM audit_log WHERE type = 'lot.create' ORDER BY id").all();
    db.db.close();
    assert.equal(rows.length, 2);
    assert.equal(rows[1].reason, '模型であることを現物で確かめた');
    assert.deepEqual(JSON.parse(rows[1].after).warnings, ['実銃']);
  } finally { await srv.stop().catch(() => {}); cleanup(ctx); }
});
