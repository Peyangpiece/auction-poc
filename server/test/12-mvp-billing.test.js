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
import { execFileSync } from 'node:child_process';
// PDF の中の文字（道具が入っていない環境では、確かめを飛ばす）
const pdfText = (file) => { try { return execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }); } catch { return null; } };

const DAY = 86400000;
async function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auction-bill-'));
  const config = loadConfig({ POC_DATA_DIR: dataDir, POC_AUTH_RATE: '0', POC_AUTO_APPROVE: '1' });
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
    assert.equal((await b.post('/api/register/complete', { kind: 'b2c', name: `検証 ${n}郎`, email: `m${n}@example.com`, address: `東京都千代田区${n}`, adult: true, agreed: true })).status, 200);
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
    api, store, dataDir, admin, browser, staffLogin, member, sold, lines, line, endEvent, outbox, today, eventId,
    // 日を進める。スタッフのログインは12時間で切れるので、進めたらログインし直す
    advance: async (days) => { now += days * DAY; for (const b of staff) await b.login(); },
    close: async () => { await new Promise((r) => server.close(r)); await api.billing.filesIdle(); store.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
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
    assert.deepEqual([first.premium, first.payable], [200, 2200], '買歩銭は、落札額の10%。払う金額は、落札額＋買歩銭');
    assert.match(t.outbox().find((m) => m.kind === 'won' && m.to === a.email).body, /買歩銭\s+¥200（落札額の10%）.*¥2,200/s, '落札の知らせに、買歩銭と払う金額を書く');
    assert.ok(t.outbox().some((m) => m.kind === 'won' && m.to === a.email), '落札者に、メールでも知らせる');

    assert.equal((await auctioneer.post('/api/billing/settle', { lineIds: [first.id] })).status, 403, '進行役は、精算できない');
    assert.equal((await reception.post(`/api/billing/lines/${first.id}/deliver`)).status, 409, '消し込みの前は、引き渡せない');
    const settled = await reception.post('/api/billing/settle', { lineIds: [first.id] });
    assert.equal(settled.status, 200);
    assert.match(settled.json.invoice.number, /^20261207-0001$/, '請求書番号は「年月日-連番」');
    assert.equal(settled.json.invoice.total, 2200, '請求書の合計は、落札額＋買歩銭');
    const after = await t.line('飯ごう');
    assert.deepEqual([after.state, after.clearedMethod, after.invoice.kind], ['cleared', 'cash', 'cash']);
    assert.equal((await reception.post('/api/billing/settle', { lineIds: [first.id] })).status, 409, '2度は精算できない');
    assert.equal((await reception.post(`/api/billing/lines/${first.id}/deliver`)).status, 200, '精算したら、引き渡しを記録できる');
    assert.equal(t.outbox().filter((m) => m.channel === 'draft').length, 0, '当日現金の精算では、メールの下書きを作らない');

    // 請求書のファイル: PDF は本人と主催者管理者・受付係、Excel は主催者管理者だけ
    const pdf = await a.get(`/api/billing/invoices/${settled.json.invoice.id}/pdf`);
    assert.equal(pdf.type, 'application/pdf');
    assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-');
    // ファイルが無くなっていても（作っている最中に落ちた・保存先へ送る前に入れ替わった）、開くときに作り直す
    const pdfFile = t.store.db.prepare('SELECT pdf_file FROM invoices WHERE id = ?').get(settled.json.invoice.id).pdf_file;
    fs.rmSync(pdfFile);
    const again = await a.get(`/api/billing/invoices/${settled.json.invoice.id}/pdf`);
    assert.deepEqual([again.status, again.buf.subarray(0, 5).toString()], [200, '%PDF-']);
    assert.ok(fs.existsSync(pdfFile));
    assert.ok(pdf.buf.includes(Buffer.from('/FontFile2')), '日本語の書体を埋め込んでいる');
    assert.equal((await b.get(`/api/billing/invoices/${settled.json.invoice.id}/pdf`)).status, 404, 'ほかの会員の請求書は開けない');
    assert.equal((await a.get(`/api/billing/invoices/${settled.json.invoice.id}/xlsx`)).status, 401);
    assert.equal((await t.admin.get(`/api/billing/invoices/${settled.json.invoice.id}/xlsx`)).buf.subarray(0, 2).toString(), 'PK');

    t.sold('寝袋', [[a, 3000]]);                         // 15時: a がもう1つ落札。精算しないまま開催終了
    t.sold('水筒', [[b, 500]]);
    const made = await t.endEvent();
    assert.equal(made.length, 2, '落札者ごとに1通');
    const invA = made.find((i) => i.account_id === 1);
    assert.deepEqual([invA.kind, invA.total], ['transfer', 3300], '15時の明細だけが載る（11時の明細は載らない）。当日現金を選んでいても、振込の請求書になる');
    const drafts = t.outbox().filter((m) => m.channel === 'draft');
    assert.deepEqual(drafts.map((d) => d.to).sort(), [a.email, b.email], '送付用のメールの下書きを作る（送信はしない）');
    assert.ok(fs.existsSync(drafts[0].attachments[0]), '下書きには、PDF を添付する');
    // 請求メールの下書き: 件名に金額と期限、本文に期限・内訳・振込先・依頼人名の書き方・連絡先（報告書 68 章）
    const mine = drafts.find((d) => d.to === a.email);
    assert.match(mine.subject, /^【令和の競り】\d+月\d+日（.）のご請求　¥[\d,]+（お支払い期限 \d+月\d+日（.））$/);
    for (const want of ['お支払い期限', '【内訳】', '買歩銭（落札額の10%）', '【お振込先】', 'ご依頼人名の前に、請求書番号', '振込手数料は、お客様のご負担', '（うち消費税']) assert.ok(mine.body.includes(want), want);
    const list = (await t.admin.get('/api/billing/invoices')).json.invoices;
    assert.deepEqual(list.map((i) => [i.kind, i.sentOn, i.dueDate]), [['transfer', null, '2026-12-12'], ['transfer', null, '2026-12-12'], ['cash', null, null]], '支払期限は、発行日（12/7）の5日後の日付。現金の精算には、期限はない');
  } finally { await t.close(); }
});

test('当日クレジット: 会場参加の人だけが選べる。会場で精算すると、クレジットで受け取った記録になる。支払方法ごとに管理できる（報告書 133 章）', async () => {
  const t = await setup();
  try {
    const reception = await t.staffLogin('reception', 'uketsuke');
    const a = await t.member(1, { venue: true, payment: 'card' });   // 会場参加・当日クレジット
    const b = await t.member(2);                                      // オンライン参加・銀行振込
    const c = await t.member(3, { venue: true });                     // 会場参加・当日現金
    assert.equal((await b.post('/api/my/participation', { payment: 'card' })).status, 400, 'オンライン参加は、当日クレジットに変えられない');
    // まちがえて会場参加を選んだ人が、オンライン参加に直すと、当日クレジットは銀行振込になる
    const d = await t.member(4, { venue: true, payment: 'card' });
    const sw = await d.post('/api/my/participation/online');
    assert.deepEqual([sw.status, sw.json.mode, sw.json.payment, sw.json.paymentChanged], [200, 'online', 'transfer', true]);
    t.sold('飯ごう', [[b, 1000], [a, 2000]]);
    t.sold('寝袋', [[a, 1000], [b, 3000]]);
    t.sold('水筒', [[a, 1000], [c, 4000]]);
    t.sold('ランタン', [[b, 1000], [a, 5000]]);
    const first = await t.line('飯ごう');
    assert.deepEqual([first.payment, first.payMethod, first.state], ['card', 'card', 'unsettled'], '未精算のあいだは、本人が選んだ方法');
    assert.equal((await reception.post('/api/billing/settle', { lineIds: [first.id], method: 'transfer' })).status, 400, '会場での精算は、当日現金か当日クレジットだけ');
    const settled = await reception.post('/api/billing/settle', { lineIds: [first.id], method: 'card' });
    assert.deepEqual([settled.status, settled.json.method, settled.json.methodLabel], [200, 'card', '当日クレジット']);
    const after = await t.line('飯ごう');
    assert.deepEqual([after.state, after.clearedMethod, after.payMethod, after.invoice.kind], ['cleared', 'card', 'card', 'cash'], '請求書は、会場での精算（領収書を兼ねる）');
    const pdfFile = t.store.db.prepare('SELECT pdf_file FROM invoices WHERE id = ?').get(settled.json.invoice.id).pdf_file;
    const txt = pdfText(pdfFile);
    if (txt !== null) assert.match(txt, /クレジットにて領収しました/);
    assert.equal(t.store.db.prepare('SELECT method FROM clearings WHERE line_id = ?').get(first.id).method, 'card');
    // 当日現金を選んだ人を、クレジットで精算してもよい（その場で変えた）: 実際に受け取った方法で数える
    const w = await t.line('水筒');
    assert.equal((await reception.post('/api/billing/settle', { lineIds: [w.id], method: 'card' })).status, 200);
    assert.deepEqual([(await t.line('水筒')).payment, (await t.line('水筒')).payMethod], ['cash', 'card']);
    // 当日クレジットを選んで、会場で精算しなかった品は、開催終了のあと、銀行振込の請求書になる
    await t.endEvent();
    const lantern = await t.line('ランタン');
    assert.deepEqual([lantern.payment, lantern.payMethod, lantern.invoice.kind], ['card', 'transfer', 'transfer']);
    // 開催終了のあとに会場・事務所で受け取ったクレジットの記録は、受付係もできる
    assert.equal((await reception.post(`/api/billing/lines/${lantern.id}/clear`, { amount: lantern.payable, method: 'card' })).status, 200);
    assert.equal((await t.line('ランタン')).payMethod, 'card');
  } finally { await t.close(); }
});

test('支払期限は発行日の5日後の日付。送付済みの記録。消し込みは金額が一致するときだけ', async () => {
  const t = await setup();
  try {
    const a = await t.member(1);
    t.sold('飯ごう', [[a, 2000]]);
    const [inv] = await t.endEvent();
    assert.equal(inv.due_date, '2026-12-12', '12/7 に発行 → 期限は 12/12（土曜でも、そのままの日付）');
    const l = await t.line('飯ごう');
    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/clear`, { amount: 2200 })).status, 200, '送付の前でも、入金があれば消し込める');
    await t.admin.post(`/api/billing/lines/${l.id}/unclear`, { reason: '検証のため' });
    // 送ったことの記録（期限は変わらない）と、その取り消し
    assert.equal((await t.admin.post(`/api/billing/invoices/${inv.id}/sent`)).json.dueDate, '2026-12-12');
    assert.equal((await t.admin.get('/api/billing/invoices')).json.invoices[0].sentOn, '2026-12-07');
    await t.admin.post(`/api/billing/invoices/${inv.id}/unsent`);
    assert.deepEqual([(await t.admin.get('/api/billing/invoices')).json.invoices[0].sentOn, (await t.line('飯ごう')).invoice.dueDate], [null, '2026-12-12']);
    await t.admin.post(`/api/billing/invoices/${inv.id}/sent`);

    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/clear`, { amount: 2000 })).status, 400, '落札額だけ（買歩銭を除いた金額）では、消し込めない');
    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/clear`, { amount: 2201 })).status, 400, '多すぎる入金でも、消し込めない');
    const reception = await t.staffLogin('reception', 'uketsuke');
    assert.equal((await reception.post(`/api/billing/lines/${l.id}/clear`, { amount: 2200 })).status, 403, '受付係は、振込を消し込めない');
    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/clear`, { amount: 2200 })).status, 200);
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
    await t.admin.post(`/api/billing/invoices/${inv.id}/sent`);                    // 期限は 12/12（発行日の5日後）
    const l1 = await t.line('飯ごう'), l2 = await t.line('寝袋');
    assert.equal((await t.admin.post(`/api/billing/lines/${l1.id}/cancel`, { reason: '未払い' })).status, 409, '期限の前は、解除できない');
    await t.advance(5);                                                                   // 12/12: 期限の当日は、まだ未払いではない
    assert.equal((await a.get('/api/me')).json.member.suspended, false);
    await t.advance(1);                                                                   // 12/13 0時を過ぎた
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
    assert.equal((await t.admin.post(`/api/billing/lines/${l1.id}/clear`, { amount: 2200 })).status, 200);
    assert.equal((await a.get('/api/me')).json.member.suspended, true);
    // 残りを解除すると、ほかに期限を過ぎた請求がないので、自動の停止は解ける（AC-FR-AUTH-015-3）
    assert.equal((await t.admin.post(`/api/billing/lines/${l2.id}/cancel`, {})).status, 400, '解除には理由が要る');
    assert.equal((await t.admin.post(`/api/billing/lines/${l2.id}/cancel`, { reason: '期限を過ぎても入金がない' })).status, 200);
    assert.ok(t.outbox().some((m) => m.kind === 'cancelled' && m.to === a.email), '元の落札者に、メールで知らせる');
    assert.equal((await a.get('/api/me')).json.member.suspended, false);
    assert.equal((await t.admin.post(`/api/billing/lines/${l2.id}/clear`, { amount: 3300 })).status, 409, '解除した明細は、消し込めない');
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
    assert.equal((await t.admin.post(`/api/billing/invoices/${penInv.id}/sent`)).json.dueDate, addDays(t.today(), 7), '違約金は、発行日の7日後');
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
    await t.advance(6);
    await t.admin.post(`/api/billing/lines/${l.id}/cancel`, { reason: '未払い' });
    const offer = await t.admin.post(`/api/billing/lines/${l.id}/offer`);
    assert.deepEqual([offer.json.amount, offer.json.deadline], [1800, addDays(t.today(), 3)], '価格は、次点の人の最後の有効な入札額。回答期限は3日目まで');
    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/offer`)).status, 409, '打診は1人だけ（3番目の人には打診しない）');
    assert.equal((await b.get('/api/my/billing')).json.offers.length, 0);
    const mine = (await c.get('/api/my/billing')).json.offers;
    assert.equal((await c.post('/api/my/withdraw')).status, 409, '繰り上げの打診に答えていないあいだは、退会できない（本番運用の評価 B5）');
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
    await t.advance(6);                                                    // 12/13: 支払期限（12/12）を過ぎた。受け取り期限（12/14）の前日でもある
    assert.equal(t.api.billing.sweep().pickup, 1);
    assert.ok(t.outbox().some((m) => m.kind === 'pickup' && m.to === b.email));
    assert.equal(t.api.billing.sweep().pickup, 0, '同じ知らせは、2度送らない');
    const l = await t.line('飯ごう');
    await t.admin.post(`/api/billing/lines/${l.id}/cancel`, { reason: '未払い' });
    await t.admin.post(`/api/billing/lines/${l.id}/offer`);                // 12/13 に打診 → 12/16 まで
    await t.advance(2);                                                    // 12/15: まだ回答できる。受け取り期限は過ぎた
    const pickup = (await t.admin.get('/api/billing/pickup')).json.lines;
    assert.deepEqual(pickup.map((x) => [x.label.includes('水筒'), x.pickupLate]), [[true, true]], '未引き取りの一覧に載り、期限を過ぎたものは強調する');
    assert.equal((await b.get('/api/my/billing')).json.offers[0].state, 'open');
    await t.advance(2);                                                    // 12/17
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
    assert.equal((await t.admin.post(`/api/billing/lines/${d.id}/clear`, { amount: 1089 })).status, 200); // 12月: 振込（落札額 990円＋買歩銭 99円）。C は未払いのまま
    const dec = (await t.admin.get('/api/billing/fees?month=2026-12')).json;
    // 対象は 3,010円。5% = 150.5 → 150円（合計に1回だけ丸める。1件ごとなら 50+50+49=149 になる）
    assert.deepEqual([dec.base, dec.fee, dec.tax, dec.total], [3010, 150, 15, 165], '未払いの C（5,000円）は数えない。買歩銭は対象に含めない。外税で消費税を足す');
    assert.equal(dec.details.length, 3);
    // 違約金は、手数料の対象に含めない
    await t.advance(30);                                                              // 1月
    await t.admin.post(`/api/billing/lines/${c.id}/cancel`, { reason: '未払い' });
    const pen = await t.admin.post(`/api/billing/lines/${c.id}/penalty`, { amount: 500 });
    const penLine = (await t.lines()).find((l) => l.kind === 'penalty');
    assert.equal((await t.admin.post(`/api/billing/lines/${penLine.id}/clear`, { amount: 500 })).status, 200, '違約金には、買歩銭はかからない');
    assert.ok(pen.json.invoice);
    // 1月に、12月の消し込み（D）を取り消し、A を返金した → 1月の手数料から差し引く（1件ごとに切り上げ）
    await t.admin.post(`/api/billing/lines/${d.id}/unclear`, { reason: '別の人の入金だった' });
    assert.equal((await t.admin.post(`/api/billing/lines/${ids[0]}/refund`, { amount: 1112, date: t.today(), method: 'cash', reason: '返品' })).status, 400, '払う金額（1,010＋買歩銭101）を超える返金は断る');
    assert.equal((await t.admin.post(`/api/billing/lines/${ids[0]}/refund`, { amount: 1111, date: '2099-01-01', method: 'cash', reason: '返品' })).status, 400, '未来の日の返金は断る');
    await t.admin.post(`/api/billing/lines/${ids[0]}/refund`, { amount: 1111, date: t.today(), method: 'cash', reason: '返品' }); // 全額の返金
    const jan = (await t.admin.get(`/api/billing/fees?month=${t.today().slice(0, 7)}`)).json;
    assert.deepEqual([jan.base, jan.deduction, jan.fee], [0, 50 + 51, 0], '990×5%=49.5→50、1,010×5%=50.5→51。手数料は0円より下にはしない');
    // 引ききれなかった 101円は、消えずに、次の月へ繰り越す（報告書 118 章）
    assert.deepEqual([jan.carriedIn, jan.carriedOut], [0, 101]);
    const next = new Date(Date.UTC(Number(t.today().slice(0, 4)), Number(t.today().slice(5, 7)), 1)).toISOString().slice(0, 7);
    const feb = (await t.admin.get(`/api/billing/fees?month=${next}`)).json;
    assert.deepEqual([feb.carriedIn, feb.fee, feb.carriedOut], [101, 0, 101], '次の月に引き継ぐ');
    assert.equal((await t.admin.get('/api/billing/fees?month=2026-12')).json.fee, 150, '締めた月の金額は、あとから変わらない');
    // 確認済みにする。内税と最低保証額
    assert.equal((await t.admin.post('/api/billing/fees/confirm', { month: t.today().slice(0, 7) })).status, 409, '今月は、まだ確認済みにできない');
    assert.equal((await t.admin.post('/api/billing/fees/confirm', { month: '2026-12' })).status, 200);
    assert.equal((await t.admin.get('/api/billing/fees?month=2026-12')).json.confirmedOn, t.today());
    assert.equal((await t.admin.post(`/api/billing/lines/${ids[1]}/refund`, { amount: 100, date: '2026-12-20', method: 'cash', reason: '一部返品' })).status, 409, '確認済みの月の日付の返金は断る');
    // 一部の返金は、返金額のうち落札額にあたる分の 5% を差し引く（落札額全体ではない。本番運用の評価 B1）
    await t.admin.post(`/api/billing/lines/${ids[1]}/refund`, { amount: 555, date: t.today(), method: 'cash', reason: '一部返品' });
    const jan2 = (await t.admin.get(`/api/billing/fees?month=${t.today().slice(0, 7)}`)).json;
    assert.equal(jan2.deduction, 50 + 51 + 26, '555円の返金のうち落札額の分は 505円 → 5%=25.25→26');
    await t.admin.post('/api/settings', { orgName: '株式会社レイワ', returnPolicy: '仮', shippingNotice: '仮', feeTaxMode: 'inclusive', feeMinimum: '1000' });
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
    // 画面で選んだ開催に合わせた書き出し（発注者の決定。報告書 125 章）: その開催の分だけ。無い開催は 404
    const one = await t.admin.get(`/api/billing/shipping.csv?event=${t.eventId}`);
    assert.match(one.buf.toString('utf8'), /"飯ごう"/);
    assert.equal((await t.admin.get('/api/billing/shipping.csv?event=99999')).status, 404);
    { // 別の開催の明細は、入らない
      const other = t.store.db.prepare("INSERT INTO events (title, starts_at, ends_at, venue_name, venue_address, highlights, notified, status, phase, created_at) VALUES ('前の競り','2026-11-01T09:00','2026-11-01T18:00','x','x','',1,'published','ended',1)").run().lastInsertRowid;
      t.store.db.prepare("INSERT INTO bill_lines (kind, event_id, account_id, label, amount, receive, created_at) SELECT 'lot', ?, account_id, 'No.9 前の開催の品', 700, 'ship', 1 FROM bill_lines LIMIT 1").run(other);
      assert.match((await t.admin.get('/api/billing/shipping.csv')).buf.toString('utf8'), /前の開催の品/, '開催を選ばなければ、全部');
      assert.doesNotMatch((await t.admin.get(`/api/billing/shipping.csv?event=${t.eventId}`)).buf.toString('utf8'), /前の開催の品/);
      assert.match((await t.admin.get(`/api/billing/shipping.csv?event=${other}`)).buf.toString('utf8'), /前の開催の品/);
      assert.deepEqual((await t.admin.get('/api/billing/lines')).json.events.map((e) => e.id), [t.eventId, Number(other)], '開催は、新しい順');
      t.store.db.prepare('DELETE FROM bill_lines WHERE event_id = ?').run(other);
    }
    assert.match(csv.buf.toString('utf8'), /"2026-12-07","1","飯ごう","2000","検証 1郎","","東京都千代田区1","090-6666-0001","",""/);
    // 配送先を別に書いた会員: 先頭の郵便番号を、郵便番号の列に分ける。電話番号は、表計算ソフトで先頭の 0 が消えない形
    await a.post('/api/my/profile', { name: '検証 1郎', email: 'a1@example.com', address: '東京都千代田区1', shipTo: '〒1500001 東京都渋谷区神宮前1-1' });
    assert.match((await t.admin.get('/api/billing/shipping.csv')).buf.toString('utf8'), /"検証 1郎","150-0001","東京都渋谷区神宮前1-1","090-6666-0001"/);
    await t.admin.post(`/api/billing/invoices/${inv.id}/sent`);
    await t.advance(33);
    assert.equal((await t.admin.get('/api/billing/long-unpaid')).json.lines.length, 0, '期限の翌日から30日たつまでは、載らない');
    await t.advance(2);
    assert.deepEqual((await t.admin.get('/api/billing/long-unpaid')).json.lines.map((x) => x.label), ['No.1 飯ごう']);
  } finally { await t.close(); }
});

test('印鑑の画像: 主催者管理者だけが登録できる。PNG か JPEG だけ。登録すると、請求書に押される', async () => {
  const t = await setup();
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const reception = await t.staffLogin('reception', 'uketsuke');
    assert.equal((await reception.post('/api/settings/seal', { image: png.toString('base64') })).status, 403);
    assert.equal((await t.admin.get('/api/settings/seal')).status, 404);
    assert.equal((await t.admin.post('/api/settings/seal', { image: Buffer.from('<svg/>').toString('base64') })).status, 400, '画像でなければ断る');
    const a = await t.member(1, { venue: true });
    t.sold('飯ごう', [[a, 2000]]);
    const before = (await t.admin.post('/api/billing/settle', { lineIds: [(await t.line('飯ごう')).id] })).json.invoice;
    assert.equal((await t.admin.post('/api/settings/seal', { image: png.toString('base64') })).status, 200);
    assert.equal((await t.admin.get('/api/settings/seal')).type, 'image/png');
    t.sold('寝袋', [[a, 3000]]);
    const after = (await t.admin.post('/api/billing/settle', { lineIds: [(await t.line('寝袋')).id] })).json.invoice;
    const images = async (inv) => (await t.admin.get(`/api/billing/invoices/${inv.id}/pdf`)).buf.toString('latin1').split('/Subtype /Image').length - 1;
    assert.ok(await images(after) > await images(before), '印鑑を登録したあとの請求書には、画像が増える');
    assert.equal((await t.admin.post('/api/settings/seal', { image: null })).json.registered, false);
    assert.equal((await t.admin.get('/api/settings/seal')).status, 404);
  } finally { await t.close(); }
});

test('送料: 金額をあとから手で入れる。まだ送っていない請求書に行を足して作り直す。なければ、送料だけの請求書を出す', async () => {
  const t = await setup();
  try {
    const a = await t.member(1, { receive: 'ship' });
    const b = await t.member(2, { venue: true, receive: 'ship' });
    t.sold('飯ごう', [[a, 2000]]);
    t.sold('寝袋', [[b, 3000]]);
    await t.admin.post('/api/billing/settle', { lineIds: [(await t.line('寝袋')).id] });       // b は当日現金で精算済み
    const [inv] = await t.endEvent();
    assert.equal(inv.total, 2200);
    const reception = await t.staffLogin('reception', 'uketsuke');
    assert.equal((await reception.post('/api/billing/shipping', { accountId: 1, eventId: t.eventId, amount: 1500, label: 'ヤマト運輸 120サイズ' })).status, 403, '送料を入れられるのは、主催者管理者だけ');
    assert.equal((await t.admin.post('/api/billing/shipping', { accountId: 1, eventId: t.eventId, amount: -1 })).status, 400);

    // 送る前の請求書に、送料の行を足す
    const added = await t.admin.post('/api/billing/shipping', { accountId: 1, eventId: t.eventId, amount: 1500, label: 'ヤマト運輸 120サイズ' });
    assert.deepEqual([added.json.invoice.id, added.json.invoice.total], [inv.id, 3700], '同じ請求書に足し、合計が増える（落札 2,000＋買歩銭 200＋送料 1,500）');
    const ship = (await t.lines()).find((l) => l.kind === 'shipping');
    assert.deepEqual([ship.label, ship.amount, ship.premium], ['【送料】ヤマト運輸 120サイズ', 1500, 0], '送料には、買歩銭はかからない');
    // 金額を直す → 行は増えない
    assert.equal((await t.admin.post('/api/billing/shipping', { accountId: 1, eventId: t.eventId, amount: 2000, label: 'ヤマト運輸 180サイズ' })).json.invoice.total, 4200);
    assert.equal((await t.lines()).filter((l) => l.kind === 'shipping').length, 1);
    const list = (await t.admin.get('/api/billing/invoices')).json.invoices.find((i) => i.id === inv.id);
    assert.deepEqual(list.shipping, { amount: 2000, label: '【送料】ヤマト運輸 180サイズ' });
    // 0円で、行を消す
    assert.equal((await t.admin.post('/api/billing/shipping', { accountId: 1, eventId: t.eventId, amount: 0 })).json.invoice.total, 2200);
    await t.admin.post('/api/billing/shipping', { accountId: 1, eventId: t.eventId, amount: 2000, label: 'ヤマト運輸 180サイズ' });

    // 送ったあとの請求書は変えない → 新しく、送料だけの請求書になる
    await t.admin.post(`/api/billing/invoices/${inv.id}/sent`);
    const extra = await t.admin.post('/api/billing/shipping', { accountId: 1, eventId: t.eventId, amount: 300, label: '追加の箱' });
    assert.notEqual(extra.json.invoice.id, inv.id);
    assert.equal(extra.json.invoice.total, 300);
    // 現金で精算済みの人（送る前の請求書がない）にも、送料だけの請求書を出せる
    const cashShip = await t.admin.post('/api/billing/shipping', { accountId: 2, eventId: t.eventId, amount: 1800, label: '佐川急便 140サイズ' });
    assert.equal(cashShip.json.invoice.total, 1800);
    const pdf = await b.get(`/api/billing/invoices/${cashShip.json.invoice.id}/pdf`);
    assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-', '本人が、送料の請求書を開ける');

    // 送料も、金額が一致すれば消し込める。引き渡しの対象ではない。開発・運営者の手数料の対象でもない
    const first = (await t.lines()).find((l) => l.label === '【送料】ヤマト運輸 180サイズ');
    assert.equal((await t.admin.post(`/api/billing/lines/${first.id}/clear`, { amount: 2000 })).status, 200);
    assert.equal((await t.admin.post(`/api/billing/lines/${first.id}/deliver`)).status, 409);
    assert.equal((await t.admin.get(`/api/billing/fees?month=${t.today().slice(0, 7)}`)).json.base, 3000, '手数料の対象は、消し込み済みの落札額（寝袋 3,000円）だけ');
    assert.ok((await t.admin.get('/api/audit')).json.entries.some((e) => e.type === 'billing.shipping'));
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- そのほかの機能
test('開発・運営者の役割: 手数料の集計・長く未払いの一覧・監査ログだけを見られる（8.14）', async () => {
  const t = await setup();
  try {
    const op = await t.staffLogin('operator', 'unei');
    for (const url of ['/api/billing/fees', '/api/billing/long-unpaid', '/api/audit']) assert.equal((await op.get(url)).status, 200, url);
    for (const url of ['/api/members', '/api/billing/lines', '/api/billing/invoices', '/api/settings', '/api/staff/accounts', '/api/reception']) assert.equal((await op.get(url)).status, 403, url);
    assert.equal((await op.post('/api/billing/fees/confirm', { month: '2026-11' })).status, 403, '確認済みにできるのは、主催者管理者だけ');
    assert.equal((await t.admin.get('/api/staff/accounts')).json.staff.find((s) => s.loginId === 'unei').roleLabel, '開発・運営者');
  } finally { await t.close(); }
});

test('会員: 登録内容の変更（メールは確かめ直す）、電話番号の変更は主催者管理者、退会（未払いがあればできない。FR-AUTH-014）', async () => {
  const t = await setup();
  try {
    const a = await t.member(1, { venue: true });
    assert.ok((await a.post('/api/my/profile', { name: '', email: 'x', address: '' })).json.errors.email);
    const before = t.outbox().filter((m) => m.kind === 'verify_email').length;
    const up = await a.post('/api/my/profile', { name: '検証 一郎', email: 'new@example.com', address: '東京都港区9-9', shipTo: '東京都港区1-1' });
    assert.deepEqual([up.json.member.name, up.json.member.email, up.json.member.emailVerified, up.json.member.shipTo], ['検証 一郎', 'new@example.com', false, '東京都港区1-1']);
    assert.equal(t.outbox().filter((m) => m.kind === 'verify_email').length, before + 1, '新しいアドレスに、確認メールを送る');
    assert.equal(up.json.member.phone, '09066660001', '電話番号は、本人では変えられない');

    assert.equal((await t.admin.post('/api/members/1/phone', { phone: '090-7777-0001' })).status, 400, '本人を確かめた方法が要る');
    assert.equal((await t.admin.post('/api/members/1/phone', { phone: '090-7777-0001', reason: '会場で、運転免許証で確かめた' })).status, 200);
    assert.equal((await a.get('/api/me')).json.member, null, '古い番号でのログインは切れる');

    const b = await t.member(2, { venue: true });
    t.sold('飯ごう', [[b, 2000]]);
    const blocked = await b.post('/api/my/withdraw');
    assert.equal(blocked.status, 409);
    assert.match(blocked.json.message, /お支払いが済んでいない/);
    await t.admin.post('/api/billing/settle', { lineIds: [(await t.line('飯ごう')).id] });
    assert.equal((await b.post('/api/my/withdraw')).status, 200);
    assert.equal((await b.get('/api/me')).json.member, null);
    const row = (await t.admin.get('/api/members')).json.members.find((m) => m.id === 2);
    assert.deepEqual([row.withdrawn, row.phone], [true, '09066660002'], '退会しても、記録は残る');
    assert.equal((await t.line('飯ごう')).name, '検証 2郎', '取引の記録も残る');
    // 同じ電話番号で、もう一度登録できる
    const again = t.browser();
    assert.equal((await again.post('/api/register/start', { phone: '09066660002' })).status, 200);
  } finally { await t.close(); }
});

test('スタッフ: 認証アプリとパスワードの再発行（それまでのログインは切れる）。QR コードを返す', async () => {
  const t = await setup();
  try {
    const made = (await t.admin.post('/api/staff/accounts', { loginId: 'shinko', name: '進行 次郎', role: 'auctioneer' })).json;
    assert.match(made.qrSvg, /^<svg/, '認証アプリに読み取らせる QR コード');
    const s = t.browser();
    assert.equal((await s.post('/api/staff/login', { loginId: 'shinko', password: made.initialPassword, code: totp(made.totpSecret) })).status, 200);
    const reset = (await t.admin.post(`/api/staff/accounts/${made.id}/reset`)).json;
    assert.notEqual(reset.totpSecret, made.totpSecret);
    assert.match(reset.qrSvg, /^<svg/);
    assert.equal((await s.get('/api/me')).json.staff, null, '再発行すると、それまでのログインは切れる');
    assert.equal((await t.browser().post('/api/staff/login', { loginId: 'shinko', password: made.initialPassword, code: totp(made.totpSecret) })).status, 401, '古い情報では入れない');
    assert.equal((await t.browser().post('/api/staff/login', { loginId: 'shinko', password: reset.initialPassword, code: totp(reset.totpSecret) })).status, 200);
  } finally { await t.close(); }
});

test('規約類: 主催者管理者が文面を入れると、だれでも読める。利用規約があれば、登録のときに同意が必須', async () => {
  const t = await setup();
  try {
    assert.equal((await t.browser().get('/api/legal')).json.docs.terms.body, '');
    const reception = await t.staffLogin('reception', 'uketsuke');
    assert.equal((await reception.post('/api/settings/legal', { terms: 'x' })).status, 403);
    const long = '第1条（検証用の文面）\n' + 'あ'.repeat(30000);
    assert.equal((await t.admin.post('/api/settings/legal', { terms: long, privacy: '個人情報の取り扱い（検証用）' })).status, 200);
    const docs = (await t.browser().get('/api/legal')).json.docs;
    assert.deepEqual([docs.terms.title, docs.terms.body.length, docs.privacy.body, docs.tokushoho.body], ['利用規約', long.length, '個人情報の取り扱い（検証用）', '']);
    // 同意なしでは登録できない
    const b = t.browser();
    await b.post('/api/register/start', { phone: '09088880001' });
    await b.post('/api/register/verify', { phone: '09088880001', code: /(\d{6})/.exec(t.outbox().filter((m) => m.channel === 'sms' && m.to === '09088880001').at(-1).body)[1] });
    const person = { kind: 'b2c', name: '検証 花子', email: 'h@example.com', address: '東京都千代田区1', adult: true };  // 同意なし
    assert.ok((await b.post('/api/register/complete', person)).json.errors.agreed);
    assert.equal((await b.post('/api/register/complete', { ...person, agreed: true })).status, 200);
  } finally { await t.close(); }
});

test('受付で、参加手続きを代わりに行う（会場参加・来場確認済みになる）', async () => {
  const t = await setup();
  try {
    const reception = await t.staffLogin('reception', 'uketsuke');
    // 会員登録だけ済ませた人
    const b = t.browser();
    await b.post('/api/register/start', { phone: '09088880002' });
    await b.post('/api/register/verify', { phone: '09088880002', code: /(\d{6})/.exec(t.outbox().filter((m) => m.channel === 'sms' && m.to === '09088880002').at(-1).body)[1] });
    await b.post('/api/register/complete', { kind: 'b2c', name: '検証 三郎', email: 's@example.com', address: '東京都千代田区3', adult: true, agreed: true });
    assert.equal((await reception.post('/api/reception/join', { phone: '09099999999', receive: 'pickup', payment: 'cash' })).status, 404);
    assert.equal((await reception.post('/api/reception/join', { phone: '09088880002', receive: 'pickup' })).status, 400, '受け取り方法と支払方法の両方が要る');
    const joined = await reception.post('/api/reception/join', { phone: '090-8888-0002', receive: 'pickup', payment: 'cash' });
    assert.deepEqual([joined.status, joined.json.paddle], [200, 1]);
    const p = (await b.get('/api/participation')).json;
    assert.deepEqual([p.joined, p.mode, p.checkedIn, p.payment, p.paddle], [true, 'venue', true, 'cash', 1]);
    assert.equal((await reception.post('/api/reception/join', { phone: '09088880002', receive: 'ship', payment: 'transfer' })).status, 409, '2度はできない');
    assert.equal(t.api.proxyTarget(1).paddle_no, 1, '代理入札の対象になる');
  } finally { await t.close(); }
});

test('個人の上限額は持たない（発注者の決定）: 設定に送っても保存されず、入札は止まらない', async () => {
  const t = await setup();
  try {
    const a = await t.member(1);
    t.sold('飯ごう', [[a, 6000]]);
    const m = t.store.db.prepare('SELECT id, account_id, event_id FROM members WHERE id = ?').get(a.pid);
    await t.admin.post('/api/settings', { orgName: '株式会社レイワ', returnPolicy: '仮', shippingNotice: '仮', b2cLimit: '1000' });
    assert.equal((await t.admin.get('/api/settings')).json.b2cLimit, undefined);
    assert.equal(t.api.bidGate(m, { lotId: 999, amount: 1_000_000 }), null);
  } finally { await t.close(); }
});

test('違約金・遅延損害金の金額の案、帳簿の出力、請求書の一覧（Excel）', async () => {
  const t = await setup();
  try {
    const a = await t.member(1), b = await t.member(2, { venue: true });
    t.sold('飯ごう', [[a, 10000]]);
    t.sold('寝袋', [[b, 3000]]);
    const sleeping = await t.line('寝袋');
    await t.admin.post('/api/billing/settle', { lineIds: [sleeping.id] });
    await t.admin.post(`/api/billing/lines/${sleeping.id}/deliver`);
    const [inv] = await t.endEvent();
    await t.admin.post(`/api/billing/invoices/${inv.id}/sent`);            // 期限 12/12
    const l = await t.line('飯ごう');
    assert.equal((await t.admin.get(`/api/billing/lines/${l.id}/penalty-suggest`)).json.amount, null, '率が設定されていなければ、案は出さない');
    await t.admin.post('/api/settings', { orgName: '株式会社レイワ', returnPolicy: '仮', shippingNotice: '仮', penaltyRateB2c: '10', lateRateB2c: '14.6' });
    await t.advance(15);                                                   // 12/22: 期限から10日
    await t.admin.post(`/api/billing/lines/${l.id}/cancel`, { reason: '未払い' });
    assert.equal((await t.admin.get(`/api/billing/lines/${l.id}/penalty-suggest`)).json.amount, 1000, '違約金の案: 落札額 10,000円 × 10%');
    const late = (await t.admin.get(`/api/billing/lines/${l.id}/penalty-suggest?kind=late`)).json;
    assert.deepEqual([late.days, late.amount], [10, Math.floor(11000 * 14.6 / 100 * 10 / 365)], '遅延損害金の案: 期限の翌日から解除の日までを日割りし、1円未満は切り捨て');

    const ledger = await t.admin.get('/api/billing/ledger.csv?month=2026-12');
    assert.match(ledger.buf.toString('utf8'), /"2026-12-07","2","寝袋","1","","3000","検証 2郎","東京都千代田区2","090-6666-0002"/, '引き渡した品だけが、帳簿に出る');
    assert.equal(ledger.buf.toString('utf8').includes('飯ごう'), false);
    const xlsx = await t.admin.get('/api/billing/invoices.xlsx?month=2026-12');
    assert.equal(xlsx.buf.subarray(0, 2).toString(), 'PK');
    assert.match((await t.admin.get(`/api/billing/ledger.csv?event=${t.eventId}`)).buf.toString('utf8'), /"寝袋"/, '開催で選んだ帳簿');
    assert.equal((await t.admin.get(`/api/billing/invoices.xlsx?event=${t.eventId}`)).buf.subarray(0, 2).toString(), 'PK');
    const reception = await t.staffLogin('reception', 'uketsuke');
    assert.equal((await reception.get('/api/billing/ledger.csv')).status, 403);
  } finally { await t.close(); }
});

test('請求書の件名は「開催日 令和の競り」だけ（開催の名前は入れない）', async () => {
  const t = await setup();
  try {
    const a = await t.member(1, { venue: true });
    t.sold('飯ごう', [[a, 2000]]);
    const inv = (await t.admin.post('/api/billing/settle', { lineIds: [(await t.line('飯ごう')).id] })).json.invoice;
    // Excel の中身から、件名を読む（PDF は、文字が埋め込みの書体の番号になっているため）
    const { default: ExcelJS } = await import('exceljs');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await t.admin.get(`/api/billing/invoices/${inv.id}/xlsx`)).buf);
    const cells = [];
    book.worksheets[0].eachRow((row) => cells.push(String(row.getCell(1).value ?? '')));
    assert.ok(cells.includes('件名 : 12.7 令和の競り'), cells.find((c) => c.startsWith('件名')));
  } finally { await t.close(); }
});

test('終了の操作を忘れた開催を、管理画面から終えて請求書を作る。今日の開催を終えたら、前日の開催に戻らない（本番運用の評価 A5。報告書 103 章）', async () => {
  const t = await setup();
  try {
    const a = await t.member(1);
    t.sold('飯ごう', [[a, 2000]]);
    // 終了を押し忘れたまま2日たつ
    await t.advance(2);
    t.api.hooks.closeOut = () => ({ notHeld: 0 });
    const list = (await t.admin.get('/api/events')).json.events;
    assert.deepEqual(list.map((e) => [e.stale, e.ended]), [[true, false]], '過ぎた日の、終わっていない開催として出る');
    const reception = await t.staffLogin('reception', 'uketsuke');
    assert.equal((await reception.post(`/api/events/${t.eventId}/end`)).status, 403, '受付係は、開催を終えられない');
    const ended = await t.admin.post(`/api/events/${t.eventId}/end`);
    assert.equal(ended.status, 200);
    assert.equal(ended.json.invoices, 1, '請求書のない落札を、請求書にまとめる');
    assert.equal((await t.line('飯ごう')).invoice.kind, 'transfer');
    assert.equal((await t.admin.post(`/api/events/${t.eventId}/end`)).status, 409, '2度は終えられない');
    assert.deepEqual((await t.admin.get('/api/events')).json.events.map((e) => [e.stale, e.ended]), [[false, true]]);

    // 2日続けて開催する: 今日の開催を終えたら、きのうの（終わっていない）開催に戻らない
    const day = (n) => new Date(Date.parse(t.today() + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
    const y = (await t.admin.post('/api/events', { title: 'きのう', startsAt: `${day(-1)}T09:00`, endsAt: `${day(-1)}T18:00`, venueName: '会場', venueAddress: '住所', notified: true })).json.id;
    await t.admin.post(`/api/events/${y}/publish`);
    const d = (await t.admin.post('/api/events', { title: 'きょう', startsAt: `${day(0)}T09:00`, endsAt: `${day(0)}T18:00`, venueName: '会場', venueAddress: '住所', notified: true })).json.id;
    await t.admin.post(`/api/events/${d}/publish`);
    assert.equal(t.api.eventState().title, 'きょう');
    t.api.setPhase(null, 'ended');
    assert.equal(t.api.eventState(), null, '今日を終えたら、きのうの開催には戻らない');
    assert.equal(t.api.endedToday(), true);
    await new Promise((r) => setTimeout(r, 500)); // 請求書の PDF の書き出しを待つ
  } finally { await t.close(); }
});

test('本番運用の評価の指摘（B2〜B6・違約金の重複）: 送っていない請求書は期限切れにしない・送料の更新が重なっても PDF が壊れない・現金の精算の取り消しで請求が漏れない・退会と受付の条件（報告書 104 章）', async () => {
  const t = await setup();
  try {
    const a = await t.member(1, { receive: 'ship' }), b = await t.member(2, { venue: true }), c = await t.member(3);
    t.sold('飯ごう', [[a, 2000]]);
    t.sold('水筒', [[b, 500]]);
    // B4: 当日現金の精算を取り消すと、未精算に戻り、もう一度精算できる
    const water = await t.line('水筒');
    assert.equal((await t.admin.post('/api/billing/settle', { lineIds: [water.id] })).status, 200);
    assert.equal((await t.admin.post(`/api/billing/lines/${water.id}/unclear`, { reason: 'まちがえて精算した' })).status, 200);
    assert.deepEqual([(await t.line('水筒')).state, (await t.line('水筒')).invoice], ['unsettled', null], '請求書から外れて、未精算に戻る');
    assert.equal((await t.admin.post('/api/billing/settle', { lineIds: [water.id] })).status, 200, 'もう一度精算できる');
    const [inv] = await t.endEvent();
    // B2: 送っていない請求書は、期限を過ぎても未払いにしない（停止・督促・解除に進まない）
    await t.advance(6);
    assert.notEqual((await t.line('飯ごう')).state, 'unpaid', '送っていない請求書は、期限切れにしない');
    assert.equal((await a.get('/api/me')).json.member.suspended, false, '停止しない');
    // B3: 送料の更新が重なっても、PDF が壊れない。送料を足すと、支払期限を決め直す
    const acct = t.store.db.prepare('SELECT account_id FROM bill_lines WHERE label LIKE ?').get('%飯ごう%').account_id;
    const rs = await Promise.all([600, 700, 800, 900].map((amount) => t.admin.post('/api/billing/shipping', { accountId: acct, eventId: t.eventId, amount, label: 'ヤマト' })));
    assert.ok(rs.every((r) => r.status === 200));
    const fresh = t.store.db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
    const pdf = fs.readFileSync(fresh.pdf_file);
    assert.ok(pdf.subarray(0, 5).toString() === '%PDF-' && pdf.subarray(-6).toString().includes('%%EOF'), 'PDF が壊れていない');
    assert.ok(fresh.due_date > t.today(), '送料を足した日に、支払期限を決め直す');
    // 送ってから期限を過ぎると、未払い → 停止
    await t.admin.post(`/api/billing/invoices/${inv.id}/sent`);
    await t.advance(6);
    assert.equal((await t.line('飯ごう')).state, 'unpaid');
    // 違約金は、同じ明細に1回まで
    const l = await t.line('飯ごう');
    await t.admin.post(`/api/billing/lines/${l.id}/cancel`, { reason: '未払い' });
    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/penalty`, { amount: 300 })).status, 200);
    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/penalty`, { amount: 300 })).status, 409, '2度目の違約金は断る');
    const pen = (await t.lines()).find((x) => x.kind === 'penalty');
    assert.equal((await t.admin.post(`/api/billing/lines/${pen.id}/penalty`, { amount: 100 })).status, 409, '違約金の明細に違約金はかけない');
    // B6: 承認されていない会員は、受付で参加手続きできない
    t.store.db.prepare('UPDATE member_accounts SET approved_at = NULL WHERE email = ?').run(c.email);
    assert.equal((await t.admin.post('/api/reception/join', { phone: '09066660003', receive: 'pickup', payment: 'cash' })).status, 409);
    assert.ok(t.api.bidGate(t.store.db.prepare('SELECT * FROM members WHERE id = ?').get(c.pid)), '承認されていない会員は、入札（代理入札を含む）できない');
    await new Promise((r) => setTimeout(r, 500));
  } finally { await t.close(); }
});

test('入金の記録: 入金の日を入れられる（期限・受け取りの期限は入金の日で数える）。現金の受け取りは受付係もできる（本番運用の評価 C。報告書 108 章）', async () => {
  const t = await setup();
  try {
    const a = await t.member(1), b = await t.member(2);
    t.sold('飯ごう', [[a, 2000]]);
    t.sold('水筒', [[b, 500]]);
    const invs = await t.endEvent();
    for (const i of invs) await t.admin.post(`/api/billing/invoices/${i.id}/sent`);
    await t.advance(3);
    const day = (n) => new Date(Date.parse(t.today() + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
    const l = await t.line('飯ごう');
    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/clear`, { amount: l.payable, paidOn: day(1) })).status, 400, '未来の入金日は断る');
    assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/clear`, { amount: l.payable, paidOn: day(-2) })).status, 200);
    const cleared = await t.line('飯ごう');
    assert.equal(cleared.clearedOn, day(-2), '消し込みの日は、入金の日');
    assert.equal(cleared.pickupBy, day(5), '受け取りの期限は、入金の日の翌日から7日目');
    // 受付係: 現金の受け取りはできる。振込の記録はできない
    const reception = await t.staffLogin('reception', 'uketsuke');
    const w = await t.line('水筒');
    assert.equal((await reception.post(`/api/billing/lines/${w.id}/clear`, { amount: w.payable })).status, 403, '振込の記録は、主催者管理者だけ');
    assert.equal((await reception.post(`/api/billing/lines/${w.id}/clear`, { amount: w.payable, method: 'cash' })).status, 200, '現金の受け取りは、受付係もできる');
    assert.equal((await t.line('水筒')).clearedMethod, 'cash');
  } finally { await t.close(); }
});

test('繰り上げの買歩銭は、打診のときの割合のまま。解除した明細は、請求書の金額から除く。一覧の上限で、対応の残る明細が隠れない（本番運用の評価 C。報告書 109 章）', async () => {
  const t = await setup();
  try {
    const a = await t.member(1), c = await t.member(3);
    t.sold('飯ごう', [[c, 1000], [a, 2000]]);
    t.sold('水筒', [[a, 500]]);
    const invs = await t.endEvent();
    for (const i of invs) await t.admin.post(`/api/billing/invoices/${i.id}/sent`);
    await t.advance(6);
    const l = await t.line('飯ごう');
    await t.admin.post(`/api/billing/lines/${l.id}/cancel`, { reason: '未払い' });
    // 解除: 請求書の金額は、解除した明細を除いたもの。発行したときの金額も残す
    const inv = (await t.admin.get('/api/billing/invoices')).json.invoices.find((i) => i.accountId === 1);
    assert.deepEqual([inv.total, inv.issuedTotal, inv.cancelled], [550, 2750, 1], '水筒 500円＋買歩銭 50円だけが残る');
    const mine = (await a.get('/api/my/billing')).json.invoices[0];
    assert.deepEqual([mine.total, mine.state], [550, 'overdue']);
    await t.admin.post(`/api/billing/lines/${(await t.line('水筒')).id}/cancel`, { reason: '未払い' });
    assert.equal((await a.get('/api/my/billing')).json.invoices[0].state, 'cancelled', 'すべて解除した請求書は「お支払い済み」と出さない');
    // 繰り上げ: 打診のあとに割合を変えても、案内した金額のまま請求する
    await t.admin.post(`/api/billing/lines/${l.id}/offer`);
    const offer = (await c.get('/api/my/billing')).json.offers[0];
    assert.deepEqual([offer.premium, offer.payable], [100, 1100]);
    await t.admin.post('/api/settings', { orgName: '株式会社レイワ', returnPolicy: '仮', shippingNotice: '仮', buyerPremiumRate: '20' });
    assert.equal((await c.get('/api/my/billing')).json.offers[0].payable, 1100, '割合を変えても、案内した金額は変わらない');
    await c.post(`/api/my/offers/${offer.id}`, { answer: 'accept' });
    const promoted = (await c.get('/api/my/billing')).json.lines.find((x) => x.kind === 'promote');
    assert.deepEqual([promoted.amount, promoted.premium], [1000, 100]);
    // 一覧の上限: 既定の件数を超えても、まだ入金のない明細は出る。?limit= で広げられる
    const lines = await t.admin.get('/api/billing/lines?limit=1');
    assert.equal(lines.json.limit, 1000, '既定より少なくはしない');
    const members = await t.admin.get('/api/members?limit=999999');
    assert.equal(members.json.limit, 50000, '最大は 50,000 件');
    assert.equal(members.json.more, false);
  } finally { await t.close(); }
});

test('精算の取り消し（報告書 118 章）: 開催が終わったあとに取り消した現金の明細は、振込の請求書になる。空になった領収書は「無効」と出る。請求メールの文面を、管理画面から取り出せる', async () => {
  const t = await setup();
  try {
    const b = await t.member(2, { venue: true });
    const other = await t.member(3);
    t.sold('水筒', [[b, 500]]);
    const water = await t.line('水筒');
    const cash = (await t.admin.post('/api/billing/settle', { lineIds: [water.id] })).json.invoice;
    await t.endEvent();
    const res = await t.admin.post(`/api/billing/lines/${water.id}/unclear`, { reason: '現金を受け取っていなかった' });
    assert.equal(res.status, 200);
    assert.ok(res.json.reissued, '振込の請求書を発行する');
    const after = await t.line('水筒');
    assert.equal(after.state, 'billed');
    assert.equal(after.invoice.number, res.json.reissued);
    assert.ok(after.invoice.dueDate, '期限が付く');
    // 請求の一覧は、開催ごとに分かれる（発注者の決定。報告書 124 章）: 指定が無ければ、明細のある、いちばん新しい開催。会員の順
    const byEvent = (await t.admin.get('/api/billing/lines')).json;
    assert.equal(byEvent.event, t.eventId);
    assert.deepEqual(byEvent.events.map((e) => [e.id, e.lines > 0]), [[t.eventId, true]]);
    assert.ok(byEvent.lines.every((l) => l.eventId === t.eventId) && byEvent.lines.length > 0);
    assert.equal((await t.admin.get('/api/billing/lines?event=all')).json.event, null, 'すべての開催');
    assert.equal((await t.admin.get('/api/billing/lines?event=99999')).json.event, t.eventId, '無い番号は、いちばん新しい開催に戻す');
    assert.equal((await t.admin.get(`/api/billing/invoices?event=${t.eventId}`)).json.event, t.eventId);
    const list = (await t.admin.get('/api/billing/invoices')).json.invoices;
    assert.equal(list.find((i) => i.number === cash.number).void, true, '空になった領収書は、無効');
    const mine = (await b.get('/api/my/billing')).json.invoices;
    assert.equal(mine.find((i) => i.number === cash.number).state, 'void', '会員の画面でも「お支払い済み」とは出さない');
    assert.equal(mine.find((i) => i.number === res.json.reissued).state, 'billed');
    const inv = list.find((i) => i.number === res.json.reissued);
    const mail = await t.admin.get(`/api/billing/invoices/${inv.id}/mail`);
    assert.equal(mail.status, 200);
    assert.match(mail.json.subject, /ご請求/);
    assert.match(mail.json.body, /水筒/);
    assert.equal((await t.admin.get(`/api/billing/invoices/${list.find((i) => i.number === cash.number).id}/mail`)).status, 404, '現金の領収書には、送付の文面は無い');
    assert.equal((await b.get(`/api/billing/invoices/${inv.id}/mail`)).status, 401);
    // 無効の領収書の PDF は、取り消す前の明細で、「無効」の印を入れて作り直す（発注者の決定。報告書 123 章）
    const voided = t.store.db.prepare('SELECT voided_at, void_lines, pdf_file FROM invoices WHERE number = ?').get(cash.number);
    assert.ok(voided.voided_at);
    assert.equal(JSON.parse(voided.void_lines)[0].label, after.label);
    const txt = pdfText(voided.pdf_file);
    if (txt !== null) { assert.match(txt, /無効/); assert.match(txt, /精算を取り消したため、無効です/); assert.match(txt, /水筒/, '取り消す前の明細が載る'); }
    // 領収書（振込で払った人。発注者の決定）: お支払いの確認が済むまでは、出せない。済んだら、本人と主催者管理者が開ける
    assert.equal((await b.get(`/api/billing/invoices/${inv.id}/receipt`)).status, 409);
    await t.admin.post(`/api/billing/invoices/${inv.id}/sent`);
    assert.equal((await t.admin.post(`/api/billing/lines/${after.id}/clear`, { amount: inv.total })).status, 200);
    const rc = await b.get(`/api/billing/invoices/${inv.id}/receipt`);
    assert.deepEqual([rc.status, rc.type], [200, 'application/pdf']);
    assert.equal((await t.admin.get(`/api/billing/invoices/${inv.id}/receipt`)).status, 200);
    const rtxt = pdfText(path.join(t.dataDir, 'invoices', `${inv.number}-receipt.pdf`));
    if (rtxt !== null) { assert.match(rtxt, /領収書/); assert.match(rtxt, /銀行振込にて領収しました/); assert.match(rtxt, /領収金額/); assert.doesNotMatch(rtxt, /お振込先/); }
    assert.equal((await other.get(`/api/billing/invoices/${inv.id}/receipt`)).status, 404, 'ほかの会員は、開けない');
    assert.equal((await t.admin.get(`/api/billing/invoices/${list.find((i) => i.number === cash.number).id}/receipt`)).status, 409, '当日現金の精算は、請求書が領収書を兼ねる');
    await new Promise((r) => setTimeout(r, 500));
  } finally { await t.close(); }
});

test('配送の管理（報告書 130 章）: 開催ごと・顧客ごとに、配送済みと未配送を管理する。品ごとにも記録できる。お支払いの確認の前は、配送済みにできない', async () => {
  const t = await setup();
  try {
    const a = await t.member(1, { receive: 'ship' }), b = await t.member(2), c = await t.member(3, { receive: 'ship' });
    t.sold('飯ごう', [[a, 2000]]); t.sold('寝袋', [[a, 3000]]); t.sold('水筒', [[b, 500]]); t.sold('ランタン', [[c, 1000]]);
    await t.endEvent();
    const get = async () => (await t.admin.get('/api/billing/shipping')).json;
    let s = await get();
    assert.equal(s.event, t.eventId);
    assert.deepEqual(s.events.map((e) => [e.id, e.lines, e.open]), [[t.eventId, 3, 3]], '配送の品のある開催だけ。点数と、未配送の点数');
    assert.deepEqual(s.customers.map((x) => [x.name, x.lines.length, x.state]), [['検証 1郎', 2, 'unpaid'], ['検証 3郎', 1, 'unpaid']], '顧客ごとに1件。現地受け取りの人（2郎）は、出ない');
    assert.match(s.customers[0].address, /東京都千代田区1/);
    const [l1, l2] = s.customers[0].lines, l3 = s.customers[1].lines[0];
    // お支払いの確認の前は、配送済みにできない（1件でも混ざっていれば、何も記録しない）
    const early = await t.admin.post('/api/billing/shipping/ship', { lineIds: [l1.id, l2.id] });
    assert.equal(early.status, 409);
    assert.match(early.json.message, /お支払いの確認/);
    for (const l of [l1, l2, l3]) { const line = (await t.lines()).find((x) => x.id === l.id); assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/clear`, { amount: line.payable })).status, 200); }
    assert.deepEqual((await get()).customers.map((x) => x.state), ['ready', 'ready']);
    // 品ごとに記録する → その顧客は「一部」
    // 運送会社・伝票番号を記録し、発送のお知らせメールを送る（報告書 131 章）。伝票番号は、数字だけにそろえる
    const mailsTo = (to) => t.outbox().filter((m) => m.channel === 'email' && m.to === to && m.kind === 'shipped');
    assert.deepEqual((await t.admin.post('/api/billing/shipping/ship', { lineIds: [l1.id], carrier: 'yamato', tracking: '1234-5678-9012', memo: '（例）伝票 1234' })).json, { ok: true, shipped: 1, notified: 1, notifyFailed: 0 });
    { const m = mailsTo('m1@example.com').at(-1);
      assert.match(m.subject, /商品を発送しました（1点）/);
      assert.match(m.body, /飯ごう/); assert.match(m.body, /ヤマト運輸/); assert.match(m.body, /123456789012/);
      assert.doesNotMatch(m.body, /寝袋/, 'まだ送っていない品は、書かない'); }
    s = await get();
    assert.deepEqual([s.customers[0].state, s.customers[0].lines.map((x) => [x.state, x.memo, x.carrier, x.tracking, !!x.notifiedOn])], ['partial', [['shipped', '（例）伝票 1234', 'yamato', '123456789012', true], ['ready', '', '', '', false]]]);
    assert.equal(s.events[0].open, 2);
    // 顧客ごとに、残りをまとめて記録する（済んでいるものは、そのまま）
    { const r = (await t.admin.post('/api/billing/shipping/ship', { lineIds: [l1.id, l2.id], carrier: 'sagawa', tracking: '９８７６５４３２１０', memo: '（例）伝票 5678', notify: false })).json;
      assert.deepEqual([r.shipped, r.notified], [1, 0], 'お知らせを送らない、も選べる'); }
    assert.equal(mailsTo('m1@example.com').length, 1);
    s = await get();
    assert.deepEqual([s.customers[0].state, s.customers[0].lines.map((x) => x.memo)], ['shipped', ['（例）伝票 1234', '（例）伝票 5678']], '先に記録した品のメモは、書き換えない');
    assert.deepEqual(s.customers[0].lines.map((x) => [x.carrier, x.tracking]), [['yamato', '123456789012'], ['sagawa', '9876543210']], '全角の数字も、受ける');
    assert.ok(s.sender && s.carriers.some((c) => c.key === 'sagawa' && c.name === '佐川急便'), '印刷で使う、ご依頼主と、運送会社の一覧');
    assert.equal((await t.line('飯ごう')).state, 'delivered', '配送済みは、引き渡しの記録と同じ');
    // 配送の品でないもの・現地受け取りの品は、断る
    assert.equal((await t.admin.post('/api/billing/shipping/ship', { lineIds: [(await t.line('水筒')).id] })).status, 409);
    // 受付係: 記録はできる。取り消しは、主催者管理者だけ（理由が要る）
    const reception = await t.staffLogin('reception', 'uketsuke2');
    assert.equal((await reception.post('/api/billing/shipping/ship', { lineIds: [l3.id] })).status, 200);
    assert.equal((await reception.post('/api/billing/shipping/unship', { lineIds: [l3.id], reason: 'x' })).status, 403);
    assert.equal((await t.admin.post('/api/billing/shipping/unship', { lineIds: [l3.id] })).status, 400, '理由が要る');
    assert.deepEqual((await t.admin.post('/api/billing/shipping/unship', { lineIds: [l3.id], reason: 'まちがえた' })).json, { ok: true, unshipped: 1 });
    assert.equal((await get()).customers[1].state, 'ready');
    assert.equal((await t.admin.post('/api/billing/shipping/memo', { lineIds: [l1.id], memo: '（例）直した番号' })).status, 200);
    assert.equal((await get()).customers[0].lines[0].memo, '（例）直した番号');
    // 運送会社・伝票番号を直して、お知らせを送り直す
    assert.deepEqual((await t.admin.post('/api/billing/shipping/memo', { lineIds: [l1.id], carrier: 'sagawa', tracking: '1111-2222-3333', memo: '', notify: true })).json, { ok: true, notified: 1 });
    assert.deepEqual([(await get()).customers[0].lines[0].carrier, (await get()).customers[0].lines[0].tracking], ['sagawa', '111122223333']);
    assert.match(mailsTo('m1@example.com').at(-1).body, /佐川急便[\s\S]*111122223333/);
    const types = t.store.db.prepare('SELECT type FROM audit_log').all().map((r) => r.type);
    for (const type of ['view.shipping', 'billing.deliver', 'billing.undeliver', 'billing.ship_memo']) assert.ok(types.includes(type), type);
    assert.equal((await a.get('/api/billing/shipping')).status, 401, '会員は、開けない');
    await new Promise((r) => setTimeout(r, 300));
  } finally { await t.close(); }
});

test('運送会社との連携（報告書 131 章）: 取り込み用のファイル（ヤマト運輸・佐川急便）を書き出す。発行済みのデータから、伝票番号を取り込んで、配送済みにし、お知らせを送る', async () => {
  const iconv = (await import('iconv-lite')).default;
  const t = await setup();
  try {
    const a = await t.member(1, { receive: 'ship' }), b = await t.member(2, { receive: 'ship' }), c = await t.member(3, { receive: 'ship' });
    t.sold('飯ごう', [[a, 2000]]); t.sold('寝袋', [[a, 3000]]); t.sold('水筒', [[b, 500]]); t.sold('ランタン', [[c, 1000]]);
    await t.endEvent();
    await t.admin.post('/api/settings', { ...(await t.admin.get('/api/settings')).json, orgAddress: '〒000-0000\n（例）静岡県掛川市1-2-3', orgTel: '000-0000-0000', yamatoBillingCode: '0000000000', yamatoFareNo: '01', sagawaCustomerCode: '00000000000' });
    // 1郎と2郎は、お支払いの確認が済む。3郎は、まだ
    for (const name of ['飯ごう', '寝袋', '水筒']) { const l = await t.line(name); assert.equal((await t.admin.post(`/api/billing/lines/${l.id}/clear`, { amount: l.payable })).status, 200); }
    const csv = async (q) => { const r = await t.admin.get(`/api/billing/shipping/carrier.csv?event=${t.eventId}&${q}`); assert.equal(r.status, 200, q); assert.match(r.type, /Shift_JIS/); return iconv.decode(r.buf, 'cp932').trim().split('\r\n').map((line) => line.split(',').map((v) => v.replace(/^"|"$/g, ''))); };
    // ヤマト運輸（B2クラウド）: 95列。1人に1行。お支払いの確認が済んだ、未配送の顧客だけ（3郎は入らない）
    const y = await csv('carrier=yamato&form=standard');
    assert.deepEqual([y.length, y[0].length, y[0][0], y[0][3], y[0][15]], [3, 95, 'お客様管理番号', '伝票番号', 'お届け先名']);
    const y1 = Object.fromEntries(y[0].map((h, i) => [h, y[1][i]]));
    assert.deepEqual([y1['お客様管理番号'], y1['送り状種類'], y1['お届け先名'], y1['敬称'], y1['品名１'], y1['ご依頼主郵便番号'], y1['ご依頼主住所'], y1['ご請求先顧客コード'], y1['運賃管理番号'], y1['発行枚数']],
      [`E${t.eventId}M${y[1][0].split('M')[1]}`, '0', '検証 1郎', '様', '飯ごう・寝袋', '000-0000', '（例）静岡県掛川市1-2-3', '0000000000', '01', '1']);
    assert.match(y1['出荷予定日'], /^\d{4}\/\d{2}\/\d{2}$/);
    assert.equal(y1['お届け先電話番号'], '090-6666-0001');
    // 佐川急便（e飛伝Ⅲ）: 74列
    const s = await csv('carrier=sagawa&form=standard');
    assert.deepEqual([s.length, s[0].length], [3, 74]);
    const s1 = Object.fromEntries(s[0].map((h, i) => [h, s[1][i]]));
    assert.deepEqual([s1['お客様管理番号'], s1['お届け先名称１'], s1['お客様コード'], s1['出荷個数'], s1['品名１']], [y1['お客様管理番号'], '検証 1郎', '00000000000', '1', '飯ごう・寝袋']);
    assert.match(s1['出荷日'], /^\d{8}$/);
    // 項目名つきの簡単な形
    const simple = await csv('carrier=yamato&form=simple');
    assert.deepEqual([simple[0].slice(0, 3), simple[1][2]], [['お客様管理番号', '出荷予定日', 'お届け先名'], '検証 1郎']);
    assert.equal((await t.admin.get(`/api/billing/shipping/carrier.csv?event=${t.eventId}&carrier=x`)).status, 400);
    const reception = await t.staffLogin('reception', 'uketsuke3');
    assert.equal((await reception.get(`/api/billing/shipping/carrier.csv?event=${t.eventId}&carrier=yamato`)).status, 403, '住所がまとまって入るファイルは、主催者管理者だけ');
    // 伝票番号の取り込み: 管理番号と伝票番号の組。1郎（2点）は配送済みに、3郎はお支払い待ちのまま、知らない番号は、そのまま報告する
    const ref = (n) => y.slice(1).find((r) => r[15] === `検証 ${n}郎`)?.[0];
    const refC = `E${t.eventId}M${(await t.admin.get('/api/billing/shipping')).json.customers.find((x) => x.name === '検証 3郎').accountId}`;
    const r = (await t.admin.post('/api/billing/shipping/import', { carrier: 'yamato', rows: [{ ref: ref(1), tracking: '1111-2222-3333' }, { ref: refC, tracking: '444455556666' }, { ref: 'E999M999', tracking: '1' }, { ref: 'なにか', tracking: '1' }, { ref: ref(2), tracking: '' }] })).json;
    assert.deepEqual([r.shipped, r.customers, r.notified, r.unpaid, r.unknown, r.noNumber], [2, 1, 1, [refC], ['E999M999', 'なにか'], [ref(2)]]);
    const after = (await t.admin.get('/api/billing/shipping')).json.customers;
    assert.deepEqual(after.map((x) => [x.name, x.state, x.lines[0].tracking, x.lines[0].carrier]), [['検証 1郎', 'shipped', '111122223333', 'yamato'], ['検証 2郎', 'ready', '', ''], ['検証 3郎', 'unpaid', '', '']]);
    const mail = t.outbox().filter((m) => m.channel === 'email' && m.kind === 'shipped').at(-1);
    assert.match(mail.body, /飯ごう[\s\S]*寝袋[\s\S]*ヤマト運輸[\s\S]*111122223333/);
    assert.match(mail.body, /kuronekoyamato\.co\.jp/, '追跡は、公式のサイトを案内する（伝票番号つきの直接のリンクは、作らない）');
    // もう一度取り込んでも、二重にはならない。書き出しからは、配送済みの人が外れる
    assert.equal((await t.admin.post('/api/billing/shipping/import', { carrier: 'yamato', rows: [{ ref: ref(1), tracking: '111122223333' }] })).json.shipped, 0);
    assert.equal((await csv('carrier=sagawa&form=standard')).length, 2, '残りは、2郎だけ');
    const types = t.store.db.prepare('SELECT type FROM audit_log').all().map((x) => x.type);
    for (const type of ['billing.carrier_export', 'billing.carrier_import']) assert.ok(types.includes(type), type);
    await new Promise((res) => setTimeout(res, 300));
  } finally { await t.close(); }
});
