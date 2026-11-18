// 開催のお知らせメール（発注者の指示）: 開催の前日から当日の開始までに、受け取ると決めている会員へ1通ずつ送る。データはすべて架空のもの。
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

async function setup(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auction-evmail-'));
  const config = loadConfig({ POC_DATA_DIR: dataDir, POC_AUTH_RATE: '0', POC_AUTO_APPROVE: '1', POC_MAIL_INTERVAL_MS: '0', ...env });
  const store = openDb(config.dbPath);
  let now = Date.parse('2026-12-07T01:00:00Z'); // 2026-12-07（月）10:00 日本時間
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
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b) };
  };
  const outbox = () => { const f = path.join(dataDir, 'outbox', 'outbox.ndjson'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []; };
  const s = api.createStaff({ loginId: 'kanri', name: '管理の人', role: 'admin' });
  const admin = browser();
  assert.equal((await admin.post('/api/staff/login', { loginId: 'kanri', password: s.initialPassword, code: totp(s.totpSecret) })).status, 200);
  const member = async (n) => {
    const phone = `0907777000${n}`;
    const b = browser();
    await b.post('/api/register/start', { phone });
    const sms = outbox().filter((m) => m.channel === 'sms' && m.to === phone).at(-1).body;
    await b.post('/api/register/verify', { phone, code: /(\d{6})/.exec(sms)[1] });
    assert.equal((await b.post('/api/register/complete', { kind: 'b2c', name: `検証 ${n}郎`, email: `ev${n}@example.com`, address: `東京都千代田区${n}`, adult: true, agreed: true })).status, 200);
    return Object.assign(b, { email: `ev${n}@example.com` });
  };
  const event = async (date, publish = true) => {
    const id = (await admin.post('/api/events', { title: '12月の競り', startsAt: `${date}T09:00`, endsAt: `${date}T17:00`, venueName: '検証会場', venueAddress: '埼玉県◯◯市1-2-3', highlights: '古い時計\n漆の器', notified: true })).json.id;
    if (publish) await admin.post(`/api/events/${id}/publish`);
    return id;
  };
  const mails = () => outbox().filter((m) => m.channel === 'email' && m.kind === 'event');
  return {
    api, store, admin, member, event, mails,
    at: (iso) => { now = Date.parse(iso); },
    close: async () => { await new Promise((r) => server.close(r)); store.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

test('前日に、受け取ると決めている会員へ1通ずつ送る。止めた人・退会した人には送らない。2度は送らない', async () => {
  const t = await setup({ POC_SITE_URL: 'https://seri.example.jp/' });
  try {
    const a = await t.member(1), b = await t.member(2), c = await t.member(3);
    assert.equal((await b.get('/api/me')).json.member.eventMail, true, '最初は受け取る');
    assert.deepEqual((await b.post('/api/my/event-mail', { on: false })).json.eventMail, false);
    assert.equal((await b.get('/api/me')).json.member.eventMail, false);
    assert.equal((await c.post('/api/my/withdraw')).status, 200);

    await t.event('2026-12-10');                               // 3日後: まだ送らない
    assert.equal((await t.api.sendEventMails()).sent, 0);
    await t.event('2026-12-08');                               // 明日: 公開の操作で送る
    await t.api.sendEventMails();
    const sent = t.mails();
    assert.deepEqual(sent.map((m) => m.to), [a.email]);
    assert.match(sent[0].subject, /^【令和の競り】明日 12月8日（火） 開催のお知らせ$/);
    assert.match(sent[0].body, /^検証 1郎 様/);
    assert.match(sent[0].body, /日時: 12月8日（火） 09:00〜17:00/);
    assert.match(sent[0].body, /会場: 検証会場（埼玉県◯◯市1-2-3）/);
    assert.match(sent[0].body, /・古い時計\n・漆の器/);
    assert.match(sent[0].body, /https:\/\/seri\.example\.jp\//, '設定のサイトの URL を載せる');
    assert.match(sent[0].body, /受け取らない設定にできます/, '止め方を書く');

    assert.equal((await t.api.sendEventMails()).sent, 0, '同じ開催の同じ人には、2度送らない');
    t.at('2026-12-07T23:00:00Z');                              // 12-08 08:00（当日、開始の前）に受け取りを戻した人には、当日の朝に「本日」で送る
    assert.equal((await b.post('/api/my/event-mail', { on: true })).status, 200);
    await t.api.sendEventMails();
    assert.deepEqual(t.mails().map((m) => m.to), [a.email, b.email]);
    assert.match(t.mails()[1].subject, /本日 12月8日（火）/);
  } finally { await t.close(); }
});

test('開始を過ぎた開催・公開していない開催には送らない。URL は、Host ではなく、主催者管理者が公開したときのもの', async () => {
  const t = await setup();
  try {
    await t.member(1);
    await t.event('2026-12-07');            // 今日の 9:00 開始（いまは 10:00）: 過ぎている
    await t.event('2026-12-08', false);     // 公開していない
    assert.equal((await t.api.sendEventMails()).sent, 0);
    await t.event('2026-12-08');
    await t.api.sendEventMails();
    const [m] = t.mails();
    assert.ok(m, '送った');
    assert.match(m.body, /http:\/\/127\.0\.0\.1:\d+\//, '公開の操作をしたページの URL');
  } finally { await t.close(); }
});
