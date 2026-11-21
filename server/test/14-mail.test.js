// メールの送信: アプリ → 取り次ぎ（Cloudflare の Worker）→ 送信サービス（Resend）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { handleMail } from '../../cloudflare/mail.js';
import { httpMailSender, Notifier } from '../src/mvp/notify.js';

const env = { RESEND_API_KEY: 'test-key', MAIL_FROM: '令和の競り <no-reply@example.com>' };
const post = (body) => new Request('http://mail.internal/send', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

test('取り次ぎ: 送信サービスへ、送り元・宛先・件名・本文を渡す。API キーは、返事に出さない', async () => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return Response.json({ id: 'x' }); };
  const r = await handleMail(post({ to: 'taro@example.com', subject: '認証番号', text: '123456' }), env, fetcher);
  assert.equal(r.status, 200);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(calls[0].init.body), { from: env.MAIL_FROM, to: ['taro@example.com'], subject: '認証番号', text: '123456' });
});

test('取り次ぎ: おかしな宛先・件名、設定なし、送信サービスの失敗', async () => {
  const never = async () => { throw new Error('呼ばれないはず'); };
  for (const m of [{ to: 'a@example.com, b@example.com', subject: 's', text: 't' }, { to: 'a@example.com', subject: 's\nBcc: x@example.com', text: 't' }, { to: 'a@example.com', subject: 's', text: '' }, 'こわれた']) {
    assert.equal((await handleMail(post(m), env, never)).status, 400);
  }
  assert.equal((await handleMail(post({ to: 'a@example.com', subject: 's', text: 't' }), {}, never)).status, 503);
  const failing = async () => new Response('{"message":"domain not verified"}', { status: 403 });
  const r = await handleMail(post({ to: 'a@example.com', subject: 's', text: 't' }), env, failing);
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(await r.json()).includes('test-key'));
});

test('アプリ: メールは取り次ぎへ送り、失敗したら再送して、だめなら知らせる。メール以外は、もう一方へ', async () => {
  let fail = 2;
  const got = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (fail-- > 0) { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"混んでいる"}'); return; }
    got.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const other = [], gaveUp = [];
  const n = new Notifier(httpMailSender(`http://127.0.0.1:${server.address().port}`, async (m) => { other.push(m); }), (f) => gaveUp.push(f), { waitMs: 5 });
  assert.equal(await n.email('taro@example.com', 'otp', '件名', '本文'), true);
  assert.deepEqual(got, [{ to: 'taro@example.com', subject: '件名', text: '本文' }]);
  assert.equal(other.length, 0, '送ったメールの本文は、ファイルに残さない');
  await n.draft('taro@example.com', '請求', '本文');
  assert.equal(other[0].channel, 'draft');
  fail = 99;
  assert.equal(await n.email('taro@example.com', 'otp', '件名', '本文'), false);
  assert.equal(gaveUp.length, 1);
  server.close();
});

test('CSV: 式として動く文字で始まる文字列は、ただの文字にする。数は、そのまま', async () => {
  const { csvCell } = await import('../src/mvp/billing.js');
  assert.equal(csvCell('=HYPERLINK("http://evil.test","x")'), `"'=HYPERLINK(""http://evil.test"",""x"")"`);
  assert.equal(csvCell('+81-90'), `"'+81-90"`);
  assert.equal(csvCell('@cmd'), `"'@cmd"`);
  assert.equal(csvCell('検証 太郎'), '"検証 太郎"');
  assert.equal(csvCell(-500), '"-500"');
  assert.equal(csvCell(null), '""');
});

test('宛先の検査は、送信の入口と同じ。入口が断った宛先は、送り直さない（列を止めない）', async () => {
  const { isEmail, clientIp } = await import('../src/mvp/security.js');
  for (const bad of ['x,1@a.bb', 'a;b@example.com', '<a@example.com>', 'a@b', 'a b@example.com', 'a@example.c']) assert.equal(isEmail(bad), false, bad);
  for (const good of ['taro@example.com', 'taro.yamada+seri@mail.example.co.jp']) assert.equal(isEmail(good), true, good);
  // 入口が 400 を返したら、1回でやめる。混雑（429）や、入口の故障（502）は、送り直す
  let calls = 0, status = 400;
  const server = http.createServer((req, res) => { calls++; req.resume(); res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"error":"bad message"}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const gaveUp = [];
  const n = new Notifier(httpMailSender(`http://127.0.0.1:${server.address().port}`, async () => {}), (f) => gaveUp.push(f), { waitMs: 5 });
  assert.equal(await n.email('taro@example.com', 'otp', '件名', '本文'), false);
  assert.equal(calls, 1, '400 は、送り直さない');
  calls = 0; status = 429;
  assert.equal(await n.email('taro@example.com', 'otp', '件名', '本文'), false);
  assert.equal(calls, 4, '429 は、送り直す');
  assert.equal(gaveUp.length, 2);
  server.close();
  // 接続元: IPv6 は、先頭の 64 ビットでまとめる（アドレスを変えながら、制限をすり抜けられないように）
  const req = (ip) => ({ headers: { 'x-real-ip': ip }, socket: { remoteAddress: '10.0.0.1' } });
  const cfg = { trustProxy: true };
  assert.equal(clientIp(req('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), cfg), clientIp(req('2001:db8:1:2::1'), cfg));
  assert.notEqual(clientIp(req('2001:db8:1:2::1'), cfg), clientIp(req('2001:db8:1:3::1'), cfg));
  assert.equal(clientIp(req('203.0.113.7'), cfg), '203.0.113.7');
});
