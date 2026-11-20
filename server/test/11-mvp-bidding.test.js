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

/** 条件が成り立つまで待つ（通知がすでに届いたあとでも、取りこぼさない） */
async function until(cond, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('until: 時間切れ');
    await sleep(20);
  }
}
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
  const ctx = makeEnv({ POC_AUTH_RATE: '0', POC_AUTO_APPROVE: '1' });
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
    assert.equal((await b.post('/api/register/complete', { kind: 'b2c', name, email: 'a@example.com', address: '東京都千代田区1-1', adult: true, agreed: true })).status, 200);
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
    await until(() => wa.lots.get(lot.id)?.status === 'open');

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
    await until(() => wb.lots.get(lot.id)?.status === 'open');
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

test('会場参加: QR コード → 参加手続き（当日現金も選べる）→ 受付係の来場確認で有効になる（FR-MODE-002）', async () => {
  const t = await setup();
  try {
    const a = await t.register('09055550001', '検証 一郎');
    await t.publishEvent('本日の競り');
    // 受付係を作って、ログインする
    const made = (await t.staff.post('/api/staff/accounts', { loginId: 'uketsuke', name: '受付 三郎', role: 'reception' })).json;
    const reception = browser(t.srv.httpUrl);
    assert.equal((await reception.post('/api/staff/login', { loginId: 'uketsuke', password: made.initialPassword, code: totp(made.totpSecret) })).status, 200);
    assert.equal((await a.get('/api/reception')).status, 401, '会員には、受付の画面を見せない');

    const rec = (await reception.get('/api/reception')).json;
    const code = new URL(rec.event.venueUrl).searchParams.get('venue');
    assert.ok(code.length >= 10, 'QR コードには、開催ごとの合言葉が入る');
    const qr = await fetch(t.srv.httpUrl + '/api/reception/qr.svg', { headers: { cookie: reception.cookie } });
    assert.equal(qr.headers.get('content-type'), 'image/svg+xml');
    assert.match(await qr.text(), /^<svg/);
    assert.equal((await fetch(t.srv.httpUrl + '/api/reception/qr.svg')).status, 401, 'QR コードは、スタッフだけが出せる');

    assert.equal((await a.get('/api/participation?venue=wrong')).json.venue, false);
    assert.equal((await a.get(`/api/participation?venue=${code}`)).json.venue, true);
    assert.equal((await a.post('/api/join', { receive: 'pickup', payment: 'cash', venueCode: 'wrong' })).status, 400, '合言葉が違えば、会場参加にできない');
    const joined = (await a.post('/api/join', { receive: 'pickup', payment: 'cash', venueCode: code })).json;
    assert.deepEqual([joined.paddle, joined.mode, joined.checkedIn], [1, 'venue', false], '参加番号は手続きの完了時に振る。来場確認は、まだ');
    await assert.rejects(t.ws(a), /来場の確認/, '来場確認の前は、入札画面につなげない');

    const list = (await reception.get('/api/reception')).json.participants;
    assert.deepEqual(list.map((p) => [p.paddle, p.name, p.mode, p.payment, p.checkedIn]), [[1, '検証 一郎', 'venue', 'cash', false]]);
    assert.equal((await a.post(`/api/reception/${list[0].id}/checkin`)).status, 401, '会員は、自分で来場確認できない');
    assert.equal((await reception.post(`/api/reception/${list[0].id}/checkin`)).status, 200);
    assert.equal((await a.get('/api/participation')).json.checkedIn, true);
    const wa = await t.ws(a);
    assert.equal(wa.paddle, 1);
    wa.close();
  } finally { await t.end(); }
});

test('来場確認の QR コード: 本人の画面に出し、受付係が読み取って参加者を探す（報告書 91 章）', async () => {
  const t = await setup();
  try {
    const a = await t.register('09055550001', '検証 一郎');
    const b = await t.register('09055550002', '検証 二郎');
    await t.publishEvent('本日の競り');
    const made = (await t.staff.post('/api/staff/accounts', { loginId: 'uketsuke', name: '受付 三郎', role: 'reception' })).json;
    const reception = browser(t.srv.httpUrl);
    await reception.post('/api/staff/login', { loginId: 'uketsuke', password: made.initialPassword, code: totp(made.totpSecret) });
    const venueCode = new URL((await reception.get('/api/reception')).json.event.venueUrl).searchParams.get('venue');

    assert.equal((await a.get('/api/my/checkin-qr')).status, 409, '参加手続きの前は、出さない');
    await a.post('/api/join', { receive: 'pickup', payment: 'cash', venueCode });
    await b.post('/api/join', { receive: 'ship', payment: 'transfer' });
    assert.equal((await b.get('/api/my/checkin-qr')).status, 409, 'オンライン参加には、出さない');
    const qr = await a.get('/api/my/checkin-qr');
    assert.equal(qr.status, 200);
    assert.match(qr.json.qrSvg, /^<svg/);
    assert.equal(qr.json.paddle, 1);
    const again = await a.get('/api/my/checkin-qr');
    assert.equal(again.json.qrSvg, qr.json.qrSvg, '同じ開催の中では、同じコード');

    // QR の中身（読み取った文字）を、データベースから取り出して使う
    const db = new Database(path.join(t.ctx.dataDir, 'auction.db'), { readonly: true });
    const code = 'reiwa-checkin:' + db.prepare('SELECT checkin_code FROM members WHERE paddle_no = 1 AND account_id IS NOT NULL').get().checkin_code;
    db.close();
    assert.ok(code.length > 'reiwa-checkin:'.length + 10, '中身は、推し量れない長さの乱数');
    assert.ok(!code.includes('検証') && !/:1$/.test(code), '名前や参加番号は入れない');
    assert.equal((await a.post('/api/reception/scan', { code })).status, 401, '会員は、読み取りの窓口を使えない');
    assert.equal((await reception.post('/api/reception/scan', { code: 'https://example.com/' })).status, 404, '来場確認のコードでなければ、断る');
    assert.equal((await reception.post('/api/reception/scan', { code: 'reiwa-checkin:wrong' })).status, 404);
    const hit = await reception.post('/api/reception/scan', { code });
    assert.equal(hit.status, 200);
    assert.deepEqual([hit.json.paddle, hit.json.name, hit.json.mode, hit.json.checkedIn, hit.json.payment], [1, '検証 一郎', 'venue', false, 'cash']);
    assert.equal((await a.get('/api/participation')).json.checkedIn, false, '読み取っただけでは、来場確認にしない（受付係が名前を見てから押す）');
    assert.equal((await reception.post(`/api/reception/${hit.json.id}/checkin`)).status, 200);
    assert.equal((await reception.post('/api/reception/scan', { code })).json.checkedIn, true, '2回目に読むと、確認済みと分かる');
  } finally { await t.end(); }
});

test('オンライン参加から会場参加への変更は、受付係が来場を確認したときだけ。支払方法を選び直す（FR-MODE-004、FR-PAY-002）', async () => {
  const t = await setup();
  try {
    const a = await t.register('09055550001', '検証 一郎');
    await t.publishEvent('本日の競り');
    assert.equal((await a.post('/api/join', { receive: 'ship', payment: 'cash' })).status, 400, 'オンライン参加は、当日現金を選べない');
    await a.post('/api/join', { receive: 'ship', payment: 'transfer' });
    const rec = (await t.staff.get('/api/reception')).json;
    const code = new URL(rec.event.venueUrl).searchParams.get('venue');
    // 本人が QR コードを読んでも、参加モードは変わらない
    const again = (await a.post('/api/join', { receive: 'pickup', payment: 'cash', venueCode: code })).json;
    assert.deepEqual([again.mode, again.paddle], ['online', 1]);
    const id = rec.participants[0].id;
    assert.equal((await t.staff.post(`/api/reception/${id}/checkin`)).status, 400, '切り替えには、支払方法の選び直しが要る');
    assert.equal((await t.staff.post(`/api/reception/${id}/checkin`, { payment: 'cash' })).status, 200);
    const p = (await a.get('/api/participation')).json;
    assert.deepEqual([p.mode, p.payment, p.checkedIn, p.paddle], ['venue', 'cash', true, 1], '参加番号は変わらない');
    const audit = (await t.staff.get('/api/audit')).json.entries.find((e) => e.type === 'reception.checkin');
    assert.deepEqual(JSON.parse(audit.before), { mode: 'online', payment: 'transfer', checkedIn: false });
  } finally { await t.end(); }
});

// ---------------------------------------------------------------- MVP の 5: 進行（休憩・開催終了）と、緊急用の代理入札
async function venueSetup(t) {
  const online = await t.register('09055550001', '検証 一郎');
  const venue = await t.register('09055550002', '検証 二郎');
  await t.publishEvent('本日の競り');
  await online.post('/api/join', { receive: 'ship', payment: 'transfer' });            // 参加番号 1（オンライン）
  const rec = (await t.staff.get('/api/reception')).json;
  const code = new URL(rec.event.venueUrl).searchParams.get('venue');
  await venue.post('/api/join', { receive: 'pickup', payment: 'cash', venueCode: code }); // 参加番号 2（会場）
  const id = (await t.staff.get('/api/reception')).json.participants.find((p) => p.paddle === 2).id;
  await t.staff.post(`/api/reception/${id}/checkin`);
  // 進行コンソールは、スタッフのログイン（クッキー）でつなぐ
  const con = new Client(t.srv.url, undefined, { ack: false, headers: { cookie: t.staff.cookie } });
  con.hello = { as: 'console' };
  await con.connect();
  return { online, venue, con };
}

test('進行コンソールは、スタッフのログインでつなぐ。受付係と会員は、進行できない（8.14）', async () => {
  const t = await setup();
  try {
    const { online, con } = await venueSetup(t);
    assert.equal(con.role, 'auctioneer');
    const made = (await t.staff.post('/api/staff/accounts', { loginId: 'uketsuke', name: '受付 三郎', role: 'reception' })).json;
    const reception = browser(t.srv.httpUrl);
    await reception.post('/api/staff/login', { loginId: 'uketsuke', password: made.initialPassword, code: totp(made.totpSecret) });
    for (const [who, b] of [['受付係', reception], ['会員', online], ['未ログイン', browser(t.srv.httpUrl)]]) {
      const c = new Client(t.srv.url, undefined, { ack: false, headers: { cookie: b.cookie } });
      c.hello = { as: 'console' };
      await assert.rejects(c.connect(), /進行|ログイン/, who);
    }
    con.close();
  } finally { await t.end(); }
});

test('オークショニア: 主催者管理者が登録し、次の品の開始・中断・再開と、競りの最中の4つの操作（開始値・うりきり・締め・流札）だけができる', async () => {
  const t = await setup();
  try {
    const { online, con } = await venueSetup(t);
    const made = (await t.staff.post('/api/staff/accounts', { loginId: 'hammer', name: '競り 太郎', role: 'caller' })).json;
    assert.equal(made.role, 'caller');
    const caller = browser(t.srv.httpUrl);
    await caller.post('/api/staff/login', { loginId: 'hammer', password: made.initialPassword, code: totp(made.totpSecret) });
    assert.equal((await caller.get('/api/me')).json.staff.roleLabel, 'オークショニア');
    assert.equal((await caller.get('/api/settings')).status, 403, '管理の画面の操作はできない');
    const c = new Client(t.srv.url, undefined, { ack: false, headers: { cookie: caller.cookie } });
    c.hello = { as: 'console' };
    await c.connect();
    const lot = await createLot(con, 10000, null, '時計', 20000);
    assert.match((await c.cmd('create_lot', { title: 'x', startPrice: 1000 })).message, /オークショニアにはできません/, '品の追加は、進行役が行う');
    assert.match((await c.cmd('exclude', { lotId: lot.id, reason: 'x' })).message, /オークショニアにはできません/);
    assert.match((await c.cmd('cancel', { lotId: lot.id, reason: 'x' })).message, /オークショニアにはできません/, '取りやめ（入札を無効にする）は、進行役が行う');
    assert.equal((await c.cmd('set_start', { lotId: lot.id, amount: 9000 })).ok, true);
    assert.equal((await c.cmd('start', { lotId: lot.id })).ok, true, '次の品の開始は、オークショニアもできる');
    const w1 = await t.ws(online);
    await until(() => w1.lots.get(lot.id)?.status === 'open');
    assert.equal((await c.cmd('suspend', { lotId: lot.id })).ok, true, '中断できる');
    await until(() => w1.lots.get(lot.id)?.status === 'suspended');
    assert.equal((await w1.bid(lot.id, 9000)).code, 'LOT_NOT_OPEN', '中断中は、入札を受け付けない');
    assert.equal((await c.cmd('resume', { lotId: lot.id })).ok, true, '再開できる');
    await until(() => w1.lots.get(lot.id)?.status === 'open');
    assert.equal((await w1.bid(lot.id, 9000)).accepted, true);
    assert.equal((await c.cmd('urikiri', { lotId: lot.id })).ok, true);
    assert.equal((await c.cmd('close', { lotId: lot.id })).status, 'sold');
    const lot2 = await createLot(con, 5000, null, 'テスト品', 8000); // うりきりのランプが点いていない品だけ、流札にできる
    await c.cmd('start', { lotId: lot2.id });
    assert.equal((await c.cmd('pass', { lotId: lot2.id })).status, 'unsold');
    c.close(); con.close();
  } finally { await t.end(); }
});

test('代理入札（FR-CON-005）と取り消し（AC-FR-CON-006-1）', async () => {
  const t = await setup();
  try {
    const { online, con } = await venueSetup(t);
    const w1 = await t.ws(online);
    const lot = await createLot(con, 10000);
    await con.cmd('start', { lotId: lot.id });
    await until(() => w1.lots.get(lot.id)?.status === 'open');
    assert.equal((await w1.bid(lot.id, 10000)).accepted, true);
    assert.equal((await w1.bid(lot.id, 11000)).code, 'ALREADY_HIGHEST');

    const proxy = (extra) => con.cmd('proxy_bid', { lotId: lot.id, paddle: 2, amount: 11000, reason: '電池切れ', cardChecked: true, ...extra });
    assert.match((await proxy({ cardChecked: false })).message, /札を確認/);
    assert.match((await proxy({ reason: ' ' })).message, /理由/);
    assert.match((await proxy({ paddle: 1 })).message, /会場参加で、来場確認が済んでいる人/, 'オンライン参加の人には、代理入札できない');
    assert.match((await proxy({ paddle: 99 })).message, /見つかりません/);
    assert.match((await proxy({ amount: 10000 })).message, /最低入札額より低い/, '受理の条件は、本人の入札と同じ');
    const done = await proxy();
    assert.equal(done.ok, true);
    await until(() => w1.lots.get(lot.id)?.currentPrice === 11000);
    assert.equal(w1.lots.get(lot.id).highestPaddle, 2);
    const log1 = (await con.cmd('lot_log', { lotId: lot.id })).log;
    assert.equal(log1.bids.find((b) => b.seq === done.seq).proxy_by, '管理 花子', '誰が代理で入れたかを、記録に残す');

    // その後に別の入札があると、取り消せない
    assert.equal((await w1.bid(lot.id, 12000)).accepted, true);
    assert.match((await con.cmd('proxy_cancel', { lotId: lot.id, bidSeq: done.seq, reason: '入力の誤り' })).message, /別の入札/);
    // もう一度代理入札（13,000円）→ 取り消すと、12,000円（参加番号 1）に戻る
    const second = await proxy({ amount: 13000 });
    assert.equal(second.ok, true);
    assert.match((await con.cmd('proxy_cancel', { lotId: lot.id, bidSeq: second.seq, reason: '' })).message, /理由/);
    assert.equal((await con.cmd('proxy_cancel', { lotId: lot.id, bidSeq: second.seq, reason: '入力の誤り' })).ok, true);
    await until(() => w1.lots.get(lot.id)?.currentPrice === 12000);
    assert.equal(w1.lots.get(lot.id).highestPaddle, 1, '1つ前の最高入札者に、権利が戻る');
    assert.match((await con.cmd('proxy_cancel', { lotId: lot.id, bidSeq: second.seq, reason: 'x' })).message, /見つかりません/, '2度は取り消せない');
    // 本人の入札は、取り消せない（FR-BID-007）
    const own = (await con.cmd('lot_log', { lotId: lot.id })).log.bids.find((b) => b.amount === 12000);
    assert.match((await con.cmd('proxy_cancel', { lotId: lot.id, bidSeq: own.seq, reason: 'x' })).message, /見つかりません/);

    const closed = await con.cmd('close', { lotId: lot.id });
    assert.deepEqual([closed.status, closed.paddle, closed.amount], ['sold', 1, 12000]);
    assert.match((await con.cmd('proxy_cancel', { lotId: lot.id, bidSeq: done.seq, reason: 'x' })).message, /取り消せません/, '締めの後は、取り消せない');
    const sold = (await con.cmd('sold_list')).sold;
    assert.deepEqual(sold.map((s) => [s.lotNo, s.paddle, s.amount, s.receive, s.payment]), [[1, 1, 12000, 'ship', 'transfer']], '落札の一覧に、受け取り方法と支払方法が出る');
    const types = (await t.staff.get('/api/audit')).json.entries.map((e) => e.type);
    assert.ok(types.includes('proxy.bid') && types.includes('proxy.cancel'), '操作者・理由・対象を、監査ログに残す');
    const entry = (await t.staff.get('/api/audit')).json.entries.find((e) => e.type === 'proxy.cancel');
    assert.deepEqual([entry.actor_kind, entry.actor_role, entry.reason], ['staff', 'admin', '入力の誤り']);
    w1.close(); con.close();
  } finally { await t.end(); }
});

test('休憩と開催終了（FR-CON-003、FR-EVT-003）', async () => {
  const t = await setup();
  try {
    const { online, con } = await venueSetup(t);
    const w1 = await t.ws(online);
    const events = [];
    w1.handlers.add((m) => { if (m.type === 'event') events.push(m); });
    const a = await createLot(con, 1000);
    await createLot(con, 1000);
    assert.match((await con.cmd('event_break', {})).message, /次の開始予定時刻/);
    assert.equal((await con.cmd('event_break', { resumeAt: '13:00' })).ok, true);
    await until(() => events.at(-1)?.event?.phase === 'break');
    assert.equal(events.at(-1).event.resumeAt, '13:00', '次の開始予定時刻が、参加者に届く');
    await con.cmd('start', { lotId: a.id });
    await until(() => events.at(-1)?.event?.phase === 'running', 10000);
    assert.match((await con.cmd('event_break', { resumeAt: '14:00' })).message, /進行中の品/);
    assert.match((await con.cmd('event_end')).message, /進行中の品/);
    await until(() => w1.lots.get(a.id)?.status === 'open');
    await w1.bid(a.id, 1000);
    await con.cmd('close', { lotId: a.id });

    const ended = await con.cmd('event_end');
    assert.equal(ended.ok, true);
    assert.equal(ended.notHeld, 1, '待機の品は、未実施になる');
    await until(() => events.at(-1)?.ended === true);
    assert.equal((await online.get('/api/participation')).json.event, null, '終了した開催には、参加できない');
    assert.match((await con.cmd('event_end')).message, /本日の開催はありません/, '開催終了は、やり直せない');
    assert.equal((await w1.bid(a.id, 2000)).accepted, false);
    // 終えたあとは、品の登録も断る（開催に属さない品が残り、次の開催を止めないように。本番運用の評価 A6。報告書 103 章）
    const late = await con.cmd('create_lot', { title: '終わったあとの品', startPrice: 1000 });
    assert.equal(late.ok, false);
    assert.match(late.message, /終了しています/);
    // 終わったあとにつなぎ直したスタッフの画面（会場モニターなど）には、「本日は終了」を最初の状態で送る（報告書 80 章）
    const con2 = new Client(t.srv.url, undefined, { ack: false, headers: { cookie: t.staff.cookie } });
    con2.hello = { as: 'console' };
    assert.equal((await con2.connect()).ended, true, 'つなぎ直しても、終了の表示を続けられる');
    con2.close();
    w1.close(); con.close();
  } finally { await t.end(); }
});

test('画面で「会場で参加」を選んだ人は、会場参加になる。来場確認が済むまでは、入札画面につなげない', async () => {
  const t = await setup();
  try {
    const a = await t.register('09055550011', '検証 一郎');
    await t.publishEvent('12月の競り');
    const res = await a.post('/api/join', { receive: 'pickup', payment: 'cash', mode: 'venue' });
    assert.deepEqual([res.status, res.json.mode, res.json.checkedIn], [200, 'venue', false], '会場参加なので、当日現金も選べる');
    await assert.rejects(t.ws(a), /来場の確認/, '受付の来場確認の前は、つなげない');
    // まちがえて選んだ人は、自分でオンライン参加に直せる。当日現金は、銀行振込になる
    const sw = await a.post('/api/my/participation/online', {});
    assert.deepEqual([sw.status, sw.json.mode, sw.json.payment, sw.json.paymentChanged, sw.json.paddle], [200, 'online', 'transfer', true, 1]);
    const wa = await t.ws(a);
    wa.close();
    assert.equal((await a.post('/api/my/participation/online', {})).status, 200, 'もう一度送っても、そのまま');
    // オンライン参加の人が、つないだまま会場参加に切り替えると、来場確認まで入札できない
    const wb = await t.ws(a);
    const back = await a.post('/api/my/participation/venue', {});
    assert.deepEqual([back.status, back.json.mode, back.json.checkedIn, back.json.paddle], [200, 'venue', false, 1]);
    await assert.rejects(t.ws(a), /来場の確認/);
    wb.close();
    // 来場確認が済んだあとでも、自分でオンライン参加に戻せる。来場確認は取り消される
    assert.equal((await a.post('/api/my/participation', { payment: 'cash' })).status, 200);
    const pid = (await t.staff.get('/api/reception')).json.participants[0].id;
    assert.equal((await t.staff.post(`/api/reception/${pid}/checkin`)).status, 200);
    const wc = await t.ws(a); wc.close();
    const home = await a.post('/api/my/participation/online', {});
    assert.deepEqual([home.status, home.json.mode, home.json.payment, home.json.paymentChanged], [200, 'online', 'transfer', true]);
    const wd = await t.ws(a); wd.close();
    // もう一度会場参加にすると、来場確認からやり直す
    await a.post('/api/my/participation/venue', {});
    await assert.rejects(t.ws(a), /来場の確認/);

  } finally { await t.end(); }
});

test('数でない金額の入札が届いても、サーバーは止まらない。断って、次の入札を受ける', async () => {
  const t = await setup();
  try {
    const a = await t.register('09055550001', '検証 一郎');
    await t.publishEvent('検証の競り');
    await a.post('/api/join', { receive: 'ship', payment: 'transfer' });
    const auctioneer = await connect(t.srv, t.ctx.tokens.auctioneer);
    const wa = await t.ws(a);
    const lot = await createLot(auctioneer, 1000);
    await auctioneer.cmd('start', { lotId: lot.id });
    await until(() => wa.lots.get(lot.id)?.status === 'open');
    for (const bad of ['abc', null, {}, 1e400, 1000.5]) assert.equal((await wa.bid(lot.id, bad)).accepted, false);
    wa.send({ type: 'bid' }); wa.send({ type: 'cmd' }); wa.send({ type: 'comment', text: { toString: 1 } });
    assert.equal((await wa.bid(lot.id, 1000)).accepted, true, 'そのあとの入札は、受ける');
    assert.equal((await fetch(t.srv.httpUrl + '/healthz')).status, 200);
    wa.close(); auctioneer.close();
  } finally { await t.end(); }
});

test('ログアウトした会員は、開いたままの入札画面からは、入札できない', async () => {
  const t = await setup();
  try {
    const a = await t.register('09055550001', '検証 一郎');
    await t.publishEvent('検証の競り');
    await a.post('/api/join', { receive: 'ship', payment: 'transfer' });
    const auctioneer = await connect(t.srv, t.ctx.tokens.auctioneer);
    const wa = await t.ws(a);
    const lot = await createLot(auctioneer, 1000);
    await auctioneer.cmd('start', { lotId: lot.id });
    await until(() => wa.lots.get(lot.id)?.status === 'open');
    assert.equal((await a.post('/api/logout')).status, 200);
    await assert.rejects(wa.bid(lot.id, 1000), /closed/);
    await until(() => wa.closed);
    auctioneer.close();
  } finally { await t.end(); }
});

test('きのうの開催を終了し忘れても、翌日のうちは、終了できる', async () => {
  const t = await setup();
  try {
    const yesterday = new Date(Date.now() + 9 * 3600000 - 86400000).toISOString().slice(0, 10);
    const ev = { title: 'きのうの競り', startsAt: `${yesterday}T09:00`, endsAt: `${yesterday}T23:59`, venueName: '検証会場', venueAddress: '埼玉県◯◯市1-2-3', notified: true };
    const { id } = (await t.staff.post('/api/events', ev)).json;
    assert.equal((await t.staff.post(`/api/events/${id}/publish`)).status, 200);
    const con = new Client(t.srv.url, undefined, { ack: false, headers: { cookie: t.staff.cookie } });
    con.hello = { as: 'console' };
    await con.connect();
    const ended = await con.cmd('event_end');
    assert.equal(ended.ok, true, JSON.stringify(ended));
    con.close();
  } finally { await t.end(); }
});
