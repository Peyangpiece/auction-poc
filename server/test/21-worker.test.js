// 入口の Worker（cloudflare/worker.js）。Cloudflare の部品（Durable Object・コンテナ）は、にせものに差し替えて確かめる。報告書 119 章
// 確かめるのは、この入口が決めていること（だれも入れない状態で動かさない・保守中・アプリへ渡す設定・外から届いた見出しの上書き・控えの置き場）。
// 【未検証】Cloudflare の本物の上での動き（コンテナの起動・入れ替え）は、ここでは確かめられない
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', shortCircuit: true };
    return next(specifier, context);
  },
});
globalThis.scheduler ??= { wait: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) };
const { default: entry, AuctionApp } = await import('../../cloudflare/worker.js');

/** にせもののコンテナと、Durable Object の保存 */
function fakeCtx({ running = false, stored = {} } = {}) {
  const log = { started: null, signals: [], intercepted: [], fetched: [] };
  const map = new Map(Object.entries(stored));
  const container = {
    running,
    images: { base: 'image' },
    signal: (n) => { log.signals.push(n); container.running = false; },
    monitor: async () => {},
    destroy: async () => { container.running = false; },
    setInactivityTimeout: async () => {},
    interceptOutboundHttp: async (host) => { log.intercepted.push(host); },
    start: (opts) => { log.started = opts; container.running = true; },
    getTcpPort: () => ({ fetch: async (req, init) => { const r = req instanceof Request ? req : new Request(req, init); log.fetched.push(r); return new Response('{"ok":true}', { status: 200 }); } }),
  };
  const ctx = {
    container, exports: { DataStore: 'DataStore', MailSender: 'MailSender' },
    blockConcurrencyWhile: async (fn) => fn(),
    storage: {
      get: async (k) => map.get(k), put: async (k, v) => { map.set(k, v); }, delete: async (k) => { map.delete(k); },
      list: async ({ prefix }) => new Map([...map].filter(([k]) => k.startsWith(prefix))),
    },
  };
  return { ctx, log, map };
}
const PASS = 'x'.repeat(12);

test('入口: 管理者のパスワードが入るまでは、動かさない。入っていれば、必ず同じ1台（main）へ渡す', async () => {
  const names = [];
  const env = (extra) => ({ AUCTION_APP: { getByName: (n) => { names.push(n); return { fetch: async () => new Response('app') }; } }, ...extra });
  assert.equal((await entry.fetch(new Request('https://example.test/'), env({}))).status, 503);
  assert.equal((await entry.fetch(new Request('https://example.test/'), env({ ADMIN_PASSWORD: 'short' }))).status, 503);
  assert.deepEqual(names, []);
  assert.equal(await (await entry.fetch(new Request('https://example.test/'), env({ ADMIN_PASSWORD: PASS }))).text(), 'app');
  assert.deepEqual(names, ['main']);
});

test('保守中: 動いているコンテナに、止める合図を送り、案内を返す。アプリには渡さない', async () => {
  const { ctx, log } = fakeCtx({ running: true });
  const app = new AuctionApp(ctx, { MAINTENANCE: '1', ADMIN_PASSWORD: PASS });
  const res = await app.fetch(new Request('https://example.test/'));
  assert.equal(res.status, 503);
  assert.match(await res.text(), /保守/);
  assert.deepEqual(log.signals, [15]);
  assert.equal(log.started, null);
  assert.equal(log.fetched.length, 0);
});

test('本番の設定: SMS と合言葉でのログインを止め、設定がそろうまで公開させない。お試し用の設定は入れない。外から届いた見出しは、上書きする', async () => {
  const { ctx, log } = fakeCtx();
  const app = new AuctionApp(ctx, { ADMIN_PASSWORD: PASS, DEMO: '0', BUILD: 'b1', RESEND_API_KEY: 'k', MAIL_FROM: 'f' });
  const res = await app.fetch(new Request('https://seri.example.test/api/x?y=1', { headers: { 'x-forwarded-host': 'evil.example', 'x-real-ip': '1.2.3.4', 'cf-connecting-ip': '203.0.113.9' } }));
  assert.equal(res.status, 200);
  const env = log.started.env;
  assert.deepEqual([env.POC_SMS, env.POC_TOKEN_LOGIN, env.POC_REQUIRE_SETUP], ['0', '0', '1']);
  assert.equal(env.POC_DEV_SHOW_CODES, undefined, '認証番号を画面に出す設定は、本番では入れない');
  assert.equal(env.POC_SETUP_ARGS, undefined);
  assert.equal(env.POC_JOURNAL_REPLAY, undefined, '控えのやり直しは、ふだんは止めない');
  assert.equal(env.POC_SITE_URL, 'https://seri.example.test');
  assert.equal(env.POC_IVS_MODE, 'always-live', '映像の鍵が無ければ、映像なしで動かす');
  assert.equal(log.started.enableInternet, false, '映像を使わないときは、コンテナから外へ出さない');
  assert.ok(env.POC_MAIL_URL && env.POC_PERSIST_URL);
  assert.deepEqual(log.intercepted, ['store.internal', 'mail.internal']);
  assert.equal(await ctx.storage.get('build'), 'b1');
  const sent = log.fetched.at(-1);
  assert.equal(new URL(sent.url).pathname + new URL(sent.url).search, '/api/x?y=1');
  assert.equal(sent.headers.get('x-forwarded-host'), 'seri.example.test');
  assert.equal(sent.headers.get('x-forwarded-proto'), 'https');
  assert.equal(sent.headers.get('x-real-ip'), '203.0.113.9', '接続元は、Cloudflare が付けた値だけを使う');
});

test('お試しの設定と、復元のための設定: DEMO=1 のときだけ、お試し用の設定が入る。RESTORE_SKIP_JOURNAL=1 のときだけ、控えをやり直さない', async () => {
  const { ctx, log } = fakeCtx();
  await new AuctionApp(ctx, { ADMIN_PASSWORD: PASS, DEMO: '1', RESTORE_SKIP_JOURNAL: '1' }).fetch(new Request('https://seri.example.test/'));
  const env = log.started.env;
  assert.equal(env.POC_DEV_SHOW_CODES, '1');
  assert.equal(env.POC_SMS, undefined);
  assert.equal(env.POC_JOURNAL_REPLAY, '0');
});

test('配り直したあと: 版が変わっていれば、動いているコンテナを止めて、新しい版で立ち上げる。同じ版なら、止めない', async () => {
  const a = fakeCtx({ running: true, stored: { build: 'old' } });
  await new AuctionApp(a.ctx, { ADMIN_PASSWORD: PASS, BUILD: 'new' }).fetch(new Request('https://seri.example.test/'));
  assert.deepEqual(a.log.signals, [15]);
  assert.ok(a.log.started);
  const b = fakeCtx({ running: true, stored: { build: 'same' } });
  await new AuctionApp(b.ctx, { ADMIN_PASSWORD: PASS, BUILD: 'same' }).fetch(new Request('https://seri.example.test/'));
  assert.deepEqual(b.log.signals, []);
  assert.equal(b.log.started, null);
});

test('控えの置き場: 置く・取る・並べる・消す。ほかの保存（版の印）とは、混ざらない', async () => {
  const { ctx } = fakeCtx({ stored: { build: 'b1' } });
  const app = new AuctionApp(ctx, { ADMIN_PASSWORD: PASS });
  await app.journalPut('journal/e-1-2.json.gz', new Uint8Array([1, 2, 3]).buffer);
  assert.deepEqual([...(await app.journalGet('journal/e-1-2.json.gz'))], [1, 2, 3]);
  assert.deepEqual(await app.journalList(), [{ key: 'journal/e-1-2.json.gz', size: 3 }]);
  await app.journalDelete('journal/e-1-2.json.gz');
  assert.equal(await app.journalGet('journal/e-1-2.json.gz'), null);
  assert.deepEqual(await app.journalList(), []);
});
