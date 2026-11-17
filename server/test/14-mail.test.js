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
