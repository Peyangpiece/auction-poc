// MVP の 3: 登録した会員が、参加手続きを済ませて、参加番号で入札する。締めはサーバーで確定する。
// 本物のサーバーを別プロセスで立て、ログインのクッキーで WebSocket につなぐ。データはすべて架空のもの。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { createApi } from '../src/mvp/api.js';
import { totp } from '../src/mvp/security.js';
import { makeEnv, startServer, connect, cleanup, createLot, sleep } from './helpers.js';
import { Client } from '../../tools/client.js';

/** クッキーを覚える、ブラウザの代わり */
function browser(base) {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { ...(cookie ? { cookie } : {}), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), get cookie() { return cookie; } };
}

async function setup() {
  const ctx = makeEnv({ POC_AUTH_RATE: '0' });
  // 最初の主催者管理者を作る（tools/create-admin.js と同じ処理）
  const store = openDb(path.join(ctx.dataDir, 'auction.db'));
  const admin = createApi({ store, config: loadConfig(ctx.env), nowMs: () => Date.now() }).createStaff({ loginId: 'kanri', name: '管理 花子', role: 'admin' });
  store.db.close();
  const srv = await startServer(ctx);
  const staff = browser(srv.httpUrl);
  assert.equal((await staff.post('/api/staff/login', { loginId: 'kanri', password: admin.initialPassword, code: totp(admin.totpSecret) })).status, 200);
  const lastCode = (phone) => {
    const lines = fs.readFileSync(path.join(ctx.dataDir, 'outbox', 'outbox.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    return /認証番号は (\d{6})/.exec(lines.filter((m) => m.channel === 'sms' && m.to === phone).at(-1).body)[1];
  };
  const register = async (phone, name) => {
    const b = browser(srv.httpUrl);
    await b.post('/api/register/start', { phone });
    await b.post('/api/register/verify', { phone, code: lastCode(phone) });
    assert.equal((await b.post('/api/register/complete', { kind: 'b2c', name, email: 'a@example.com', address: '東京都千代田区1-1', adult: true })).status, 200);
    return b;
  };
  // 参加できるのは開催の当日だけなので、開催日は今日（日本時間）にする
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const publishEvent = async (title, time = '09:00') => {
    const startsAt = `${today}T${time}`;
    const ev = { title, startsAt, endsAt: `${today}T23:59`, venueName: '検証会場', venueAddress: '埼玉県◯◯市1-2-3', notified: true };
    const { id } = (await staff.post('/api/events', ev)).json;
    assert.equal((await staff.post(`/api/events/${id}/publish`)).status, 200);
    return id;
  };
  const ws = async (b) => { const c = new Client(srv.url, undefined, { ack: false, headers: { cookie: b.cookie } }); await c.connect(); return c; };
  return { ctx, srv, staff, register, publishEvent, ws, today, end: async () => { await srv.stop().catch(() => {}); cleanup(ctx); } };
}

test('参加手続き: 受け取り方法と支払方法の両方に答えるまで入れない。参加番号は開催ごとに1から（FR-MODE-005、FR-NUM-001）', async () => {
  const t = await setup();
  try {
    const a = await t.register('09055550001', '検証 一郎');
    const b = await t.register('09055550002', '検証 二郎');
    assert.equal((await browser(t.srv.httpUrl).get('/api/participation')).status, 401, 'ログインが要る');
    assert.equal((await a.get('/api/participation')).json.event, null);
    assert.equal((await a.post('/api/join', { receive: 'ship', payment: 'transfer' })).status, 409, '開催がなければ、参加できない');
    await assert.rejects(t.ws(a), /本日の開催はありません/);

    await t.publishEvent('12月の競り');
    const before = (await a.get('/api/participation')).json;
    assert.deepEqual([before.joined, before.paddle, before.receive, before.payment], [false, null, null, null], 'どちらも選ばれていない状態で始まる');
    await assert.rejects(t.ws(a), /参加手続きを済ませてください/, '参加手続きの前は、入札画面につなげない（NOT_JOINED）');

    assert.deepEqual(Object.keys((await a.post('/api/join', {})).json.errors).sort(), ['payment', 'receive']);
    assert.ok((await a.post('/api/join', { receive: 'pickup' })).json.errors.payment, '片方だけでは進めない');
    assert.ok((await a.post('/api/join', { receive: 'pickup', payment: 'cash' })).json.errors.payment, 'オンライン参加は、銀行振込だけ');
    // 2人目が先に手続きを済ませる → 参加番号 1
    assert.equal((await b.post('/api/join', { receive: 'ship', payment: 'transfer' })).json.paddle, 1);
    assert.equal((await a.post('/api/join', { receive: 'pickup', payment: 'transfer' })).json.paddle, 2);
    assert.equal((await a.post('/api/join', { receive: 'ship', payment: 'transfer' })).json.paddle, 2, 'もう一度送っても、番号は変わらない');
    const after = (await a.get('/api/participation')).json;
    assert.deepEqual([after.joined, after.paddle, after.receive], [true, 2, 'pickup']);
    const wa = await t.ws(a);
    assert.equal(wa.paddle, 2, '入札画面には、参加番号で入る');
    wa.close();
  } finally { await t.end(); }
});

test('入札と締め: 会員が参加番号で入札し、締めで落札が確定する。停止中の会員は SUSPENDED（AC-FR-AUTH-009-1）', async () => {
  const t = await setup();
  try {
    const a = await t.register('09055550001', '検証 一郎');
    const b = await t.register('09055550002', '検証 二郎');
    await t.publishEvent('12月の競り');
    await a.post('/api/join', { receive: 'ship', payment: 'transfer' });
    await b.post('/api/join', { receive: 'pickup', payment: 'transfer' });
    const [wa, wb] = [await t.ws(a), await t.ws(b)];
    const auctioneer = await connect(t.srv, t.ctx.tokens.auctioneer);
    const lot = await createLot(auctioneer, 9500);
    assert.equal(lot.lotNo, 1, 'No. は、開催ごとに1から');
    await auctioneer.cmd('start', { lotId: lot.id });
    await wa.waitFor(() => wa.lots.get(lot.id)?.status === 'open');

    assert.equal((await wa.bid(lot.id, 9500)).accepted, true);
    assert.equal((await wa.bid(lot.id, 10000)).code, 'ALREADY_HIGHEST');
    assert.equal((await wb.bid(lot.id, 10000)).accepted, true);
    assert.equal((await wa.bid(lot.id, 10000)).code, 'BELOW_MINIMUM');

    // 主催者管理者が、会員 a（会員番号 1）を停止する → 以後の入札は拒否。受理済みの入札は有効のまま
    assert.equal((await t.staff.post('/api/members/1/suspend', { reason: '検証' })).status, 200);
    assert.equal((await wa.bid(lot.id, 11000)).code, 'SUSPENDED');
    assert.equal((await t.staff.post('/api/members/1/unsuspend')).status, 200);
    assert.equal((await wa.bid(lot.id, 11000)).accepted, true);
    assert.equal((await wb.bid(lot.id, 12000)).accepted, true);

    const closed = await auctioneer.cmd('close', { lotId: lot.id });
    assert.deepEqual([closed.status, closed.paddle, closed.amount], ['sold', 2, 12000], '最高の入札者（参加番号 2）が落札する');
    assert.equal((await wa.bid(lot.id, 13000)).code, 'AFTER_CLOSE');
    // 画面に出すのは参加番号だけ。名前や会員番号は、参加者には送らない
    const seen = JSON.stringify([...wa.lots.values()]);
    assert.equal(/検証 二郎|account/.test(seen), false);
    for (const c of [wa, wb, auctioneer]) c.close();
  } finally { await t.end(); }
});

test('開催が変わると、参加手続きも参加番号も No. も、その開催で1からやり直す（AC-FR-SHIP-007-2）', async () => {
  const t = await setup();
  try {
    const a = await t.register('09055550001', '検証 一郎');
    const b = await t.register('09055550002', '検証 二郎');
    const first = await t.publishEvent('12月前半の競り', '09:00');
    await a.post('/api/join', { receive: 'ship', payment: 'transfer' });
    await b.post('/api/join', { receive: 'ship', payment: 'transfer' });
    const auctioneer = await connect(t.srv, t.ctx.tokens.auctioneer);
    const stale = await t.ws(a); // 前の開催の参加番号で、つないだままにしておく
    await createLot(auctioneer, 1000);
    assert.equal((await createLot(auctioneer, 1000)).lotNo, 2);

    // 前の開催の公開を取り下げ、次の開催を公開する（開催終了の操作は MVP の 5）
    const ev = { title: '12月前半の競り', startsAt: `${t.today}T09:00`, endsAt: `${t.today}T23:59`, venueName: '検証会場', venueAddress: '埼玉県◯◯市1-2-3', notified: false };
    assert.equal((await t.staff.post(`/api/events/${first}`, ev)).status, 200);
    await t.publishEvent('12月後半の競り', '10:00');
    const p = (await b.get('/api/participation')).json;
    assert.deepEqual([p.event.title, p.joined, p.receive], ['12月後半の競り', false, null], '受け取り方法は、もう一度聞く');
    assert.equal((await b.post('/api/join', { receive: 'pickup', payment: 'transfer' })).json.paddle, 1, '参加番号は、開催ごとに1から');
    assert.equal((await createLot(auctioneer, 1000)).lotNo, 1, 'No. も、開催ごとに1から');
    const wb = await t.ws(b);
    assert.equal(wb.lots.size, 1, '前の開催の品は、画面に出ない');
    const lot = [...wb.lots.values()][0];
    await auctioneer.cmd('start', { lotId: lot.id });
    await wb.waitFor(() => wb.lots.get(lot.id)?.status === 'open');
    assert.equal((await stale.bid(lot.id, 1000)).code, 'NOT_JOINED', '前の開催の参加番号では、入札できない');
    assert.equal((await wb.bid(lot.id, 1000)).accepted, true);
    stale.close();
    wb.close(); auctioneer.close();
  } finally { await t.end(); }
});

test('以前の版のデータベースを開いても、入札の記録を保ったまま、いまの形に直る', () => {
  const ctx = makeEnv();
  try {
    const file = path.join(ctx.dataDir, 'old.db');
    const old = new Database(file);
    old.exec(`
      CREATE TABLE members (id INTEGER PRIMARY KEY, paddle_no INTEGER NOT NULL UNIQUE, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE);
      CREATE TABLE lots (id INTEGER PRIMARY KEY, lot_no INTEGER NOT NULL UNIQUE, title TEXT NOT NULL, start_price INTEGER NOT NULL, unit_override INTEGER, reserve_price INTEGER,
        status TEXT NOT NULL DEFAULT 'waiting', prep_from TEXT, no_video INTEGER NOT NULL DEFAULT 0, current_bid_seq INTEGER, close_seq INTEGER, winner_bid_seq INTEGER, updated_at REAL NOT NULL);
      CREATE TABLE bids (seq INTEGER PRIMARY KEY, lot_id INTEGER NOT NULL REFERENCES lots(id), member_id INTEGER NOT NULL REFERENCES members(id), amount INTEGER NOT NULL,
        received_at REAL NOT NULL, result TEXT NOT NULL, valid INTEGER NOT NULL DEFAULT 1, void_reason TEXT);
      INSERT INTO members VALUES (7, 3, 'テスト会員', 'h');
      INSERT INTO lots (id, lot_no, title, start_price, status, current_bid_seq, updated_at) VALUES (5, 1, '飯ごう', 1000, 'open', 9, 0);
      INSERT INTO bids VALUES (9, 5, 7, 1000, 0, 'ACCEPTED', 1, NULL);`);
    old.close();
    const store = openDb(file);
    const lot = store.q.lot.get(5);
    assert.deepEqual([lot.title, lot.current_price, lot.highest_paddle, lot.event_id], ['飯ごう', 1000, 3, null]);
    assert.equal(store.db.pragma('foreign_key_check').length, 0, '参照は壊れていない');
    // 同じ番号を、別の開催で使える
    store.db.prepare("INSERT INTO members (paddle_no, name, token_hash, event_id, account_id) VALUES (3, 'x', 'h2', 1, 1)").run();
    assert.throws(() => store.db.prepare("INSERT INTO members (paddle_no, name, token_hash, event_id, account_id) VALUES (3, 'y', 'h3', 1, 2)").run(), /UNIQUE/);
    store.db.close();
  } finally { cleanup(ctx); }
});

test('開催の予定: 公開中の開催だけを出す。当日でなければ、参加手続きはできない', async () => {
  const t = await setup();
  try {
    const a = await t.register('09055550001', '検証 一郎');
    const anon = browser(t.srv.httpUrl);
    const future = { title: '来年の競り', startsAt: '2099-01-10T09:00', endsAt: '2099-01-10T18:00', venueName: '検証会場', venueAddress: '埼玉県◯◯市1-2-3', highlights: '飯ごう\n防水シート', notified: true };
    const { id } = (await t.staff.post('/api/events', future)).json;
    assert.equal((await anon.get('/api/schedule')).json.events.length, 0, '公開の前は、予定に出ない');
    await t.staff.post(`/api/events/${id}/publish`);
    const s1 = (await anon.get('/api/schedule')).json;
    assert.equal(s1.today, t.today);
    assert.equal(s1.todayEvent, null);
    assert.deepEqual(s1.events.map((e) => [e.title, e.startsAt, e.highlights]), [['来年の競り', '2099-01-10T09:00', '飯ごう\n防水シート']]);
    assert.equal(JSON.stringify(s1).includes('"id"'), false);
    assert.equal((await a.post('/api/join', { receive: 'ship', payment: 'transfer' })).status, 409, '開催の当日でなければ、参加できない');
    await t.publishEvent('本日の競り');
    const s2 = (await anon.get('/api/schedule')).json;
    assert.equal(s2.todayEvent.title, '本日の競り');
    assert.equal(s2.events.length, 2);
    assert.equal((await a.post('/api/join', { receive: 'ship', payment: 'transfer' })).json.paddle, 1);
  } finally { await t.end(); }
});
