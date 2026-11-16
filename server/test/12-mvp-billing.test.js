// MVP の 6: 請求書・消し込み・引き渡し・未払い・解除・繰り上げ・違約金・返金・未引き取り・手数料。
// 期限を確かめるために時刻を進めたいので、API を同じプロセスの中で立てる。落札の結果は、データベースに直接置く。データはすべて架空のもの。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { createApi } from '../src/mvp/api.js';
import { totp } from '../src/mvp/security.js';
import { addDays } from '../src/mvp/billing.js';

const DAY = 86400000;
async function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auction-bill-'));
  const config = loadConfig({ POC_DATA_DIR: dataDir, POC_AUTH_RATE: '0' });
  const store = openDb(config.dbPath);
  // 2026-12-07（月）の 10:00（日本時間）から始める。曜日が決まっていないと、休業日の確かめができない
  let now = Date.parse('2026-12-07T01:00:00Z');
  const api = createApi({ store, config, nowMs: () => now });
  const server = http.createServer((req, res) => api.handle(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = () => {
    let cookie = '';
    const call = async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const buf = Buffer.from(await res.arrayBuffer());
      let json = null;
      try { json = JSON.parse(buf.toString('utf8')); } catch { /* ファイル */ }
      return { status: res.status, json, buf, type: res.headers.get('content-type') };
    };
    return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b) };
  };
  const outbox = () => { const f = path.join(dataDir, 'outbox', 'outbox.ndjson'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []; };
  const staff = [];
  const staffLogin = async (role, loginId) => {
    const s = api.createStaff({ loginId, name: `${loginId} の人`, role });
    const b = browser();
    // 二段階認証は、実際の時刻で確かめる（テスト用の時計とは別）
    b.login = async () => assert.equal((await b.post('/api/staff/login', { loginId, password: s.initialPassword, code: totp(s.totpSecret) })).status, 200);
    await b.login();
    staff.push(b);
    return b;
  };
  const admin = await staffLogin('admin', 'kanri');
  const today = () => new Date(now + 9 * 3600000).toISOString().slice(0, 10);
  const eventId = (await admin.post('/api/events', { title: '12月の競り', startsAt: `${today()}T09:00`, endsAt: `${today()}T18:00`, venueName: '検証会場', venueAddress: '埼玉県◯◯市1-2-3', notified: true })).json.id;
  await admin.post(`/api/events/${eventId}/publish`);
  const code = new URL((await admin.get('/api/reception')).json.event.venueUrl).searchParams.get('venue');
  /** 会員を登録して、参加手続きまで済ませる。venue なら会場参加（来場確認つき） */
  const member = async (n, { venue = false, receive = 'pickup', payment = venue ? 'cash' : 'transfer' } = {}) => {
    const phone = `0906666000${n}`;
    const b = browser();
    await b.post('/api/register/start', { phone });
    const sms = outbox().filter((m) => m.channel === 'sms' && m.to === phone).at(-1).body;
    await b.post('/api/register/verify', { phone, code: /(\d{6})/.exec(sms)[1] });
    assert.equal((await b.post('/api/register/complete', { kind: 'b2c', name: `検証 ${n}郎`, email: `m${n}@example.com`, address: `東京都千代田区${n}`, adult: true })).status, 200);
    const joined = (await b.post('/api/join', { receive, payment, ...(venue ? { venueCode: code } : {}) })).json;
    const pid = store.db.prepare('SELECT id FROM members WHERE event_id = ? AND paddle_no = ?').get(eventId, joined.paddle).id;
    if (venue) await admin.post(`/api/reception/${pid}/checkin`);
    return Object.assign(b, { pid, paddle: joined.paddle, email: `m${n}@example.com` });
  };
  let seq = 0, lotNo = 0;
  /** 落札の結果を置く。bids は [参加者, 金額] の並び（最後が落札者） */
  const sold = (title, bids) => {
    lotNo++;
    const lot = store.db.prepare("INSERT INTO lots (lot_no, event_id, title, start_price, status, updated_at) VALUES (?,?,?,?, 'sold', ?)").run(lotNo, eventId, title, bids[0][1], now).lastInsertRowid;
    for (const [m, amount] of bids) store.db.prepare("INSERT INTO bids (seq, lot_id, member_id, amount, received_at, result) VALUES (?,?,?,?,?,'ACCEPTED')").run(++seq, lot, m.pid, amount, now);
    store.db.prepare('UPDATE lots SET current_bid_seq = ?, winner_bid_seq = ? WHERE id = ?').run(seq, seq, lot);
    api.billing.syncLines();
    return Number(lot);
  };
  const lines = async () => (await admin.get('/api/billing/lines')).json.lines;
  const line = async (label) => (await lines()).find((l) => l.label.includes(label));
  const endEvent = async () => {
    const made = api.billing.onEventEnd(eventId, { system: true });
    await Promise.all(made.map((i) => i.done));
    api.setPhase(null, 'ended');
    await new Promise((r) => setTimeout(r, 50)); // 下書きの書き出しを待つ
    return made;
  };
  return {
    api, store, admin, browser, staffLogin, member, sold, lines, line, endEvent, outbox, today, eventId,
    // 日を進める。スタッフのログインは12時間で切れるので、進めたらログインし直す
    advance: async (days) => { now += days * DAY; for (const b of staff) await b.login(); },
    close: async () => { await new Promise((r) => server.close(r)); store.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

test('当日現金の精算と、開催終了の請求書（AC-FR-PAY-010-1、AC-FR-INV-004-1）', async () => {
  const t = await setup();
  try {
    const reception = await t.staffLogin('reception', 'uketsuke');
    const auctioneer = await t.staffLogin('auctioneer', 'shinko');
    const a = await t.member(1, { venue: true });
    const b = await t.member(2);
    t.sold('飯ごう', [[b, 1000], [a, 2000]]);          // 11時: a が落札
    const first = await t.line('飯ごう');
    assert.deepEqual([first.state, first.amount, first.paddle, first.payment], ['unsettled', 2000, 1, 'cash']);
    assert.ok(t.outbox().some((m) => m.kind === 'won' && m.to === a.email), '落札者に、メールでも知らせる');

    assert.equal((await auctioneer.post('/api/billing/settle', { lineIds: [first.id] })).status, 403, '進行役は、精算できない');
    assert.equal((await reception.post(`/api/billing/lines/${first.id}/deliver`)).status, 409, '消し込みの前は、引き渡せない');
    const settled = await reception.post('/api/billing/settle', { lineIds: [first.id] });
    assert.equal(settled.status, 200);
    assert.match(settled.json.invoice.number, /^20261207-0001$/, '請求書番号は「年月日-連番」');
    const after = await t.line('飯ごう');
    assert.deepEqual([after.state, after.clearedMethod, after.invoice.kind], ['cleared', 'cash', 'cash']);
    assert.equal((await reception.post('/api/billing/settle', { lineIds: [first.id] })).status, 409, '2度は精算できない');
    assert.equal((await reception.post(`/api/billing/lines/${first.id}/deliver`)).status, 200, '精算したら、引き渡しを記録できる');
    assert.equal(t.outbox().filter((m) => m.channel === 'draft').length, 0, '当日現金の精算では、メールの下書きを作らない');

    // 請求書のファイル: PDF は本人と主催者管理者・受付係、Excel は主催者管理者だけ
    const pdf = await a.get(`/api/billing/invoices/${settled.json.invoice.id}/pdf`);
    assert.equal(pdf.type, 'application/pdf');
    assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdf.buf.includes(Buffer.from('/FontFile2')), '日本語の書体を埋め込んでいる');
    assert.equal((await b.get(`/api/billing/invoices/${settled.json.invoice.id}/pdf`)).status, 404, 'ほかの会員の請求書は開けない');
    assert.equal((await a.get(`/api/billing/invoices/${settled.json.invoice.id}/xlsx`)).status, 401);
    assert.equal((await t.admin.get(`/api/billing/invoices/${settled.json.invoice.id}/xlsx`)).buf.subarray(0, 2).toString(), 'PK');

    t.sold('寝袋', [[a, 3000]]);                         // 15時: a がもう1つ落札。精算しないまま開催終了
    t.sold('水筒', [[b, 500]]);
    const made = await t.endEvent();
    assert.equal(made.length, 2, '落札者ごとに1通');
    const invA = made.find((i) => i.account_id === 1);
    assert.deepEqual([invA.kind, invA.total], ['transfer', 3000], '15時の明細だけが載る（11時の明細は載らない）。当日現金を選んでいても、振込の請求書になる');
    const drafts = t.outbox().filter((m) => m.channel === 'draft');
    assert.deepEqual(drafts.map((d) => d.to).sort(), [a.email, b.email], '送付用のメールの下書きを作る（送信はしない）');
    assert.ok(fs.existsSync(drafts[0].attachments[0]), '下書きには、PDF を添付する');
    const list = (await t.admin.get('/api/billing/invoices')).json.invoices;
    assert.deepEqual(list.map((i) => [i.kind, i.sentOn, i.dueDate]), [['transfer', null, null], ['transfer', null, null], ['cash', null, null]], '送付日が記録されるまで、支払期限はない');
  } finally { await t.close(); }
});

test('送付済みの記録と支払期限（送付日の翌日から5日目。休業日なら前の営業日）、消し込みは金額が一致するときだけ', async () => {
  const t = await setup();
  try {
    const a = await t.member(1);
    t.sold('飯ごう', [[a, 2000]]);
    const [inv] = await t.endEvent();
    const l = await t.line('飯ごう');
    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/clear`, { amount: 2000 })).status, 200, '送付の前でも、入金があれば消し込める');
    await t.admin.post(`/api/billing/lines/${l.id}/unclear`, { reason: '検証のため' });
    // 12/7（月）に送付 → 5日目は 12/12（土）→ 前の営業日の 12/11（金）
    assert.equal((await t.admin.post(`/api/billing/invoices/${inv.id}/sent`)).json.dueDate, '2026-12-11');
    await t.admin.post(`/api/billing/invoices/${inv.id}/unsent`);
    // 主催者設定の休業日（12/11）を足すと、さらに前の 12/10
    assert.equal((await t.admin.post('/api/settings', { orgName: '株式会社NEWS', returnPolicy: '仮', shippingNotice: '仮', bankHolidays: '2026-12-11' })).status, 200);
    assert.equal((await t.admin.post(`/api/billing/invoices/${inv.id}/sent`)).json.dueDate, '2026-12-10');

    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/clear`, { amount: 1999 })).status, 400, '一部だけの入金では、消し込めない');
    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/clear`, { amount: 2001 })).status, 400, '多すぎる入金でも、消し込めない');
    const reception = await t.staffLogin('reception', 'uketsuke');
    assert.equal((await reception.post(`/api/billing/lines/${l.id}/clear`, { amount: 2000 })).status, 403, '受付係は、振込を消し込めない');
    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/clear`, { amount: 2000 })).status, 200);
    assert.equal((await reception.post(`/api/billing/lines/${l.id}/deliver`)).status, 200);
    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/unclear`, { reason: '誤り' })).status, 409, '引き渡し済みの明細は、消し込みを取り消せない');
    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/undeliver`, {})).status, 400, '引き渡しの取り消しには、理由が要る');
    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/undeliver`, { reason: '誤って記録した' })).status, 200);
    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/unclear`, { reason: '別の人の入金だった' })).status, 200);
    assert.equal((await t.line('飯ごう')).state, 'billed');
    const types = (await t.admin.get('/api/audit')).json.entries.map((e) => e.type);
    for (const type of ['invoice.sent', 'invoice.unsent', 'billing.clear', 'billing.unclear', 'billing.deliver', 'billing.undeliver']) assert.ok(types.includes(type), type);
  } finally { await t.close(); }
});

test('未払いによる自動の停止と解除（AC-FR-AUTH-015-1・2・3）、解除した明細は消し込めない（AC-FR-PAY-006-1）', async () => {
  const t = await setup();
  try {
    const a = await t.member(1);
    t.sold('飯ごう', [[a, 2000]]);
    t.sold('寝袋', [[a, 3000]]);
    const [inv] = await t.endEvent();
    await t.admin.post(`/api/billing/invoices/${inv.id}/sent`);                    // 期限は 12/11
    const l1 = await t.line('飯ごう'), l2 = await t.line('寝袋');
    assert.equal((await t.admin.post(`/api/billing/lines/${l1.id}/cancel`, { reason: '未払い' })).status, 409, '期限の前は、解除できない');
    await t.advance(4);                                                                   // 12/11: 期限の当日は、まだ未払いではない
    assert.equal((await a.get('/api/me')).json.member.suspended, false);
    await t.advance(1);                                                                   // 12/12 0時を過ぎた
    assert.deepEqual(t.api.billing.sweep(), { overdue: 1, pickup: 0 });
    const me = (await a.get('/api/me')).json.member;
    assert.deepEqual([me.suspended, me.suspendedBy], [true, 'unpaid'], '自動で停止される');
    assert.ok(t.outbox().some((m) => m.kind === 'overdue' && m.to === a.email), '停止の理由を、メールで知らせる');
    assert.equal(t.api.billing.sweep().overdue, 0, '同じ知らせは、2度送らない');
    assert.equal(t.api.bidGate({ account_id: 1, event_id: t.api.eventId() }), 'SUSPENDED', '入札は SUSPENDED で拒否される');
    assert.equal((await t.line('飯ごう')).state, 'unpaid');

    // 督促の記録
    assert.equal((await t.admin.post(`/api/billing/lines/${l1.id}/dun`, { method: '電話', body: '不在。折り返しを依頼' })).status, 200);
    assert.equal((await t.line('飯ごう')).dunning.length, 1);
    // 片方だけ消し込んでも、もう片方が残っていれば、停止のまま
    await t.admin.post(`/api/billing/lines/${l1.id}/clear`, { amount: 2000 });
    assert.equal((await a.get('/api/me')).json.member.suspended, true);
    // 残りを解除すると、ほかに期限を過ぎた請求がないので、自動の停止は解ける（AC-FR-AUTH-015-3）
    assert.equal((await t.admin.post(`/api/billing/lines/${l2.id}/cancel`, {})).status, 400, '解除には理由が要る');
    assert.equal((await t.admin.post(`/api/billing/lines/${l2.id}/cancel`, { reason: '期限を過ぎても入金がない' })).status, 200);
    assert.ok(t.outbox().some((m) => m.kind === 'cancelled' && m.to === a.email), '元の落札者に、メールで知らせる');
    assert.equal((await a.get('/api/me')).json.member.suspended, false);
    assert.equal((await t.admin.post(`/api/billing/lines/${l2.id}/clear`, { amount: 3000 })).status, 409, '解除した明細は、消し込めない');
    assert.equal((await t.admin.post(`/api/billing/lines/${l2.id}/deliver`)).status, 409, '解除した明細は、引き渡せない');
    // 手動の停止もかかっていれば、未払いが解けても停止のまま（AC-FR-AUTH-015-2）
    await t.admin.post('/api/members/1/suspend', { reason: '検証' });
    assert.equal((await a.get('/api/me')).json.member.suspendedBy, 'manual');

    // 違約金: 解除した明細について、別の請求書で請求する。期限は、送付日の翌日から7日目（休業日でも繰り上げない）
    assert.equal((await t.admin.post(`/api/billing/lines/${l1.id}/penalty`, { amount: 300 })).status, 409, '違約金は、解除した明細について');
    const pen = await t.admin.post(`/api/billing/lines/${l2.id}/penalty`, { amount: 300 });
    assert.equal(pen.status, 200);
    const penInv = (await t.admin.get('/api/billing/invoices')).json.invoices.find((i) => i.number === pen.json.invoice);
    assert.deepEqual([penInv.kind, penInv.total], ['penalty', 300]);
    assert.equal((await t.admin.post(`/api/billing/invoices/${penInv.id}/sent`)).json.dueDate, addDays(t.today(), 7), '12/12（土）に送付 → 12/19（土）のまま');
    // 返金の記録
    assert.equal((await t.admin.post(`/api/billing/lines/${l2.id}/refund`, { amount: 3000, date: t.today(), method: 'transfer' })).status, 400, '返金には理由が要る');
    assert.equal((await t.admin.post(`/api/billing/lines/${l2.id}/refund`, { amount: 3000, date: t.today(), method: 'transfer', reason: '解除の後に入金があった' })).status, 200);
  } finally { await t.close(); }
});

test('繰り上げ: 次点の1人だけに打診し、承諾で請求書を1通発行する（FR-PAY-007）', async () => {
  const t = await setup();
  try {
    const a = await t.member(1), b = await t.member(2), c = await t.member(3);
    t.sold('飯ごう', [[c, 1000], [b, 1500], [c, 1800], [a, 2000]]);   // 次点は c（1,800円）。b は3番目
    const [inv] = await t.endEvent();
    await t.admin.post(`/api/billing/invoices/${inv.id}/sent`);
    const l = await t.line('飯ごう');
    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/offer`)).status, 409, '解除の前は、打診できない');
    await t.advance(5);
    await t.admin.post(`/api/billing/lines/${l.id}/cancel`, { reason: '未払い' });
    const offer = await t.admin.post(`/api/billing/lines/${l.id}/offer`);
    assert.deepEqual([offer.json.amount, offer.json.deadline], [1800, addDays(t.today(), 3)], '価格は、次点の人の最後の有効な入札額。回答期限は3日目まで');
    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/offer`)).status, 409, '打診は1人だけ（3番目の人には打診しない）');
    assert.equal((await b.get('/api/my/billing')).json.offers.length, 0);
    const mine = (await c.get('/api/my/billing')).json.offers;
    assert.deepEqual([mine[0].state, mine[0].amount], ['open', 1800]);
    assert.equal((await b.post(`/api/my/offers/${mine[0].id}`, { answer: 'accept' })).status, 404, 'ほかの人は、回答できない');
    const accepted = await c.post(`/api/my/offers/${mine[0].id}`, { answer: 'accept' });
    assert.equal(accepted.status, 200);
    const promoted = (await c.get('/api/my/billing')).json.lines[0];
    assert.deepEqual([promoted.kind, promoted.amount, promoted.receive, promoted.invoice.kind], ['promote', 1800, 'pickup', 'promote'], '受け取り方法は、その人がその開催で選んだもの');
    assert.equal((await c.post(`/api/my/offers/${mine[0].id}`, { answer: 'decline' })).status, 409, '回答は1度だけ');
  } finally { await t.close(); }
});

test('繰り上げの回答期限を過ぎたら、辞退とみなす。現地受け取りの期限と、前日の知らせ（FR-PAY-008）', async () => {
  const t = await setup();
  try {
    const a = await t.member(1), b = await t.member(2, { venue: true });
    t.sold('飯ごう', [[b, 1500], [a, 2000]]);
    t.sold('水筒', [[b, 500]]);
    const water = await t.line('水筒');
    await t.admin.post('/api/billing/settle', { lineIds: [water.id] });   // 12/7 に現金で精算 → 受け取りは 12/14 まで
    assert.equal((await t.line('水筒')).pickupBy, '2026-12-14');
    const [inv] = await t.endEvent();
    await t.admin.post(`/api/billing/invoices/${inv.id}/sent`);
    await t.advance(5);
    const l = await t.line('飯ごう');
    await t.admin.post(`/api/billing/lines/${l.id}/cancel`, { reason: '未払い' });
    await t.admin.post(`/api/billing/lines/${l.id}/offer`);                // 12/12 に打診 → 12/15 まで
    await t.advance(1);                                                          // 12/13: 受け取り期限の前日
    assert.equal(t.api.billing.sweep().pickup, 1);
    assert.ok(t.outbox().some((m) => m.kind === 'pickup' && m.to === b.email));
    assert.equal(t.api.billing.sweep().pickup, 0, '同じ知らせは、2度送らない');
    await t.advance(2);                                                          // 12/15: まだ回答できる。受け取り期限は過ぎた
    const pickup = (await t.admin.get('/api/billing/pickup')).json.lines;
    assert.deepEqual(pickup.map((x) => [x.label.includes('水筒'), x.pickupLate]), [[true, true]], '未引き取りの一覧に載り、期限を過ぎたものは強調する');
    assert.equal((await b.get('/api/my/billing')).json.offers[0].state, 'open');
    await t.advance(1);                                                          // 12/16
    assert.equal((await b.get('/api/my/billing')).json.offers[0].state, 'expired');
  } finally { await t.close(); }
});

test('手数料の集計: 消し込み済みだけ・消し込みの月で区切る・合計に1回だけ丸める・返金と取り消しを差し引く（FR-FEE-001〜006）', async () => {
  const t = await setup();
  try {
    const a = await t.member(1, { venue: true }), b = await t.member(2);
    t.sold('A', [[a, 1010]]); t.sold('B', [[a, 1010]]); t.sold('C', [[b, 5000]]); t.sold('D', [[b, 990]]);
    const ids = (await t.lines()).filter((l) => l.paddle === 1).map((l) => l.id);
    await t.admin.post('/api/billing/settle', { lineIds: ids });               // 12月: 現金 2,020円
    const [inv] = await t.endEvent();
    await t.admin.post(`/api/billing/invoices/${inv.id}/sent`);
    const c = await t.line('C'), d = await t.line('D');
    await t.admin.post(`/api/billing/lines/${d.id}/clear`, { amount: 990 });     // 12月: 振込 990円。C は未払いのまま
    const dec = (await t.admin.get('/api/billing/fees?month=2026-12')).json;
    // 対象は 3,010円。5% = 150.5 → 150円（合計に1回だけ丸める。1件ごとなら 50+50+49=149 になる）
    assert.deepEqual([dec.base, dec.fee, dec.tax, dec.total], [3010, 150, 15, 165], '未払いの C（5,000円）は数えない。外税で消費税を足す');
    assert.equal(dec.details.length, 3);
    // 違約金は、手数料の対象に含めない
    await t.advance(30);                                                              // 1月
    await t.admin.post(`/api/billing/lines/${c.id}/cancel`, { reason: '未払い' });
    const pen = await t.admin.post(`/api/billing/lines/${c.id}/penalty`, { amount: 500 });
    const penLine = (await t.lines()).find((l) => l.kind === 'penalty');
    await t.admin.post(`/api/billing/lines/${penLine.id}/clear`, { amount: 500 });
    assert.ok(pen.json.invoice);
    // 1月に、12月の消し込み（D）を取り消し、A を返金した → 1月の手数料から差し引く（1件ごとに切り上げ）
    await t.admin.post(`/api/billing/lines/${d.id}/unclear`, { reason: '別の人の入金だった' });
    await t.admin.post(`/api/billing/lines/${ids[0]}/refund`, { amount: 1010, date: t.today(), method: 'cash', reason: '返品' });
    const jan = (await t.admin.get(`/api/billing/fees?month=${t.today().slice(0, 7)}`)).json;
    assert.deepEqual([jan.base, jan.deduction, jan.fee], [0, 50 + 51, 0], '990×5%=49.5→50、1,010×5%=50.5→51。手数料は0円より下にはしない');
    assert.equal((await t.admin.get('/api/billing/fees?month=2026-12')).json.fee, 150, '締めた月の金額は、あとから変わらない');
    // 確認済みにする。内税と最低保証額
    assert.equal((await t.admin.post('/api/billing/fees/confirm', { month: t.today().slice(0, 7) })).status, 409, '今月は、まだ確認済みにできない');
    assert.equal((await t.admin.post('/api/billing/fees/confirm', { month: '2026-12' })).status, 200);
    assert.equal((await t.admin.get('/api/billing/fees?month=2026-12')).json.confirmedOn, t.today());
    await t.admin.post('/api/settings', { orgName: '株式会社NEWS', returnPolicy: '仮', shippingNotice: '仮', feeTaxMode: 'inclusive', feeMinimum: '1000' });
    const min = (await t.admin.get('/api/billing/fees?month=2026-12')).json;
    assert.deepEqual([min.charge, min.tax, min.total], [1000, 0, 1000], '手数料と最低保証額の大きいほう。内税なら消費税を足さない');
    const auctioneer = await t.staffLogin('auctioneer', 'shinko');
    assert.equal((await auctioneer.get('/api/billing/fees')).status, 403);
  } finally { await t.close(); }
});

test('受け取り方法・支払方法の変更は、開催終了まで本人ができる（AC-FR-SHIP-008-1）。配送の一覧。長く未払いの一覧', async () => {
  const t = await setup();
  try {
    const a = await t.member(1, { receive: 'pickup' });
    t.sold('飯ごう', [[a, 2000]]);
    assert.equal((await a.post('/api/my/participation', { payment: 'cash' })).status, 400, 'オンライン参加は、当日現金に変えられない');
    assert.equal((await a.post('/api/my/participation', { receive: 'ship' })).status, 200);
    assert.equal((await t.line('飯ごう')).receive, 'ship', '落札済みの明細にも反映する');
    const [inv] = await t.endEvent();
    const late = await a.post('/api/my/participation', { receive: 'pickup' });
    assert.equal(late.status, 409);
    assert.match(late.json.message, /変更は主催者に連絡してください/);
    const l = await t.line('飯ごう');
    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/receive`, { receive: 'pickup' })).status, 200, '開催終了の後は、主催者管理者が明細ごとに変えられる');
    await t.admin.post(`/api/billing/lines/${l.id}/receive`, { receive: 'ship' });
    const csv = await t.admin.get('/api/billing/shipping.csv');
    assert.match(csv.type, /text\/csv/);
    assert.match(csv.buf.toString('utf8'), /"検証 1郎","東京都千代田区1","09066660001","No\.1 飯ごう","2000","未","未"/);
    await t.admin.post(`/api/billing/invoices/${inv.id}/sent`);
    await t.advance(33);
    assert.equal((await t.admin.get('/api/billing/long-unpaid')).json.lines.length, 0, '期限の翌日から30日たつまでは、載らない');
    await t.advance(2);
    assert.deepEqual((await t.admin.get('/api/billing/long-unpaid')).json.lines.map((x) => x.label), ['No.1 飯ごう']);
  } finally { await t.close(); }
});
