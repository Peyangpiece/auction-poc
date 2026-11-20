// Cloudflare の入口（Worker）。届いた通信を、そのまま、アプリの入ったコンテナ（1台）へ渡す。
// 画面・API・WebSocket（入札）のすべてが、ここを通る。配り方は docs/03 の 32 章。
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { handleStore } from './store.js';
import { handleMail } from './mail.js';

const PORT = 8080;
// コンテナの中のアプリが、データの保存先（R2）を呼ぶときの名前。外のインターネットには出ない
const STORE_HOST = 'store.internal';
// メールの送信を頼むときの名前（Worker が、送信サービスへ取り次ぐ）
const MAIL_HOST = 'mail.internal';
// 通信が途絶えてから、コンテナを止めるまでの時間。止まっても、データは R2 から戻る
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

// 立ち上がりを待っているあいだに出す案内（5秒ごとに、自動で開き直す）
const STARTING_PAGE = '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>令和の競り</title><body style="font-family:sans-serif;text-align:center;padding:20vh 16px"><h1 style="font-size:20px">起動しています</h1><p>しばらくお待ちください。自動で開き直します。</p></body></html>';

const MAINTENANCE_PAGE = '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>令和の競り</title><body style="font-family:sans-serif;text-align:center;padding:20vh 16px"><h1 style="font-size:20px">ただいま保守の作業中です</h1><p>しばらくしてから、もう一度お試しください。</p></body></html>';

// コンテナからの「保存先」あての通信を受けて、R2 に出し入れする
export class DataStore extends WorkerEntrypoint {
  fetch(request) {
    // 書き込みの控え（journal/）は、入口の Durable Object の保存に置く（R2 より、ずっと速い）
    const app = this.env.AUCTION_APP.getByName('main');
    const fast = { list: () => app.journalList(), get: (key) => app.journalGet(key), put: (key, body) => app.journalPut(key, body), delete: (key) => app.journalDelete(key) };
    return handleStore(request, this.env.DATA, fast);
  }
}

// コンテナからの「メールの送信」を受けて、送信サービス（Resend）へ取り次ぐ
export class MailSender extends WorkerEntrypoint {
  fetch(request) {
    return handleMail(request, this.env);
  }
}

export class AuctionApp extends DurableObject {
  starting;

  // ---- 書き込みの控えの置き場（この Durable Object の保存）。コンテナの中のアプリが、入札のたびに書く。
  // 返事は、書き込みが消えない形で保存されてから返る（Durable Object の決まり）
  async journalPut(key, body) { await this.ctx.storage.put('j:' + key, new Uint8Array(body)); }
  async journalGet(key) { return (await this.ctx.storage.get('j:' + key)) ?? null; }
  async journalDelete(key) { await this.ctx.storage.delete('j:' + key); }
  async journalList() { return [...(await this.ctx.storage.list({ prefix: 'j:' }))].map(([key, value]) => ({ key: key.slice(2), size: value.byteLength })); }

  constructor(ctx, env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
  }

  async fetch(request) {
    // 保守中（MAINTENANCE=1）: コンテナを止めて、だれもつなげないようにする。R2 の控えから手で戻すときに、
    // 動いているコンテナに上書きされないようにするため（本番運用の評価 A9。手順は docs/05-運用手順.md の 7 章）
    if (this.env.MAINTENANCE === '1') {
      const container = this.ctx.container;
      if (container?.running) {
        container.signal(15); // 止める合図。アプリは、まだ送っていないデータを送ってから終わる
        const exited = container.monitor().catch(() => {});
        if ((await Promise.race([exited, scheduler.wait(60000).then(() => 'timeout')])) === 'timeout') await container.destroy('保守中');
      }
      return new Response(MAINTENANCE_PAGE, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '300', 'cache-control': 'no-store' } });
    }
    // 同時に届いた通信は、1回の起動を待ち合わせる
    // 公開しているアドレスを覚える（見回りの通信は、内向きの名前なので使わない）
    { const h = new URL(request.url); if (!this.publicOrigin && h.hostname !== 'internal') this.publicOrigin = `https://${h.host}`; }
    this.starting ??= this.startAndWait().finally(() => { this.starting = undefined; });
    try { await this.starting; } catch (err) {
      // 立ち上がりに時間がかかっているとき（データを戻している最中など）。エラーの画面ではなく、案内を返す
      console.error('[start]', err);
      const html = request.headers.get('upgrade') !== 'websocket' && (request.headers.get('accept') ?? '').includes('text/html');
      return new Response(html ? STARTING_PAGE : '起動中です。少し待ってから、もう一度お試しください', {
        status: 503, headers: { 'content-type': `${html ? 'text/html' : 'text/plain'}; charset=utf-8`, 'retry-after': '5', 'cache-control': 'no-store' },
      });
    }
    const url = new URL(request.url);
    const publicHost = url.host;
    url.protocol = 'http:';
    url.host = 'container';
    const forwarded = new Request(url, request);
    forwarded.headers.delete('host');
    // 外から見たサイトの名前と HTTPS であることを、アプリへ伝える（外から届いた同名のヘッダーは、ここで上書きする）
    forwarded.headers.set('x-forwarded-host', publicHost);
    forwarded.headers.set('x-forwarded-proto', 'https');
    // 利用者の接続元（Cloudflare が付ける値）。試行の回数の制限と、記録に使う
    forwarded.headers.set('x-real-ip', request.headers.get('cf-connecting-ip') ?? '');
    // 返事をそのまま返す（WebSocket への切り替えも、そのまま通る）
    return this.ctx.container.getTcpPort(PORT).fetch(forwarded);
  }

  async startAndWait() {
    const container = this.ctx.container;
    // 配り直したあとは、動いているコンテナ（前の版）を止めて、新しい版で立ち上げ直す。
    // 止める合図（SIGTERM）を送ると、アプリは、まだ送っていないデータを R2 へ送ってから終わる。
    const build = this.env.BUILD || '';
    if (container.running && build && (await this.ctx.storage.get('build')) !== build) {
      container.signal(15);
      const exited = container.monitor().catch(() => {});
      const timeout = scheduler.wait(60000).then(() => 'timeout');
      if ((await Promise.race([exited, timeout])) === 'timeout') await container.destroy('新しい版への入れ替え');
      for (let i = 0; i < 50 && container.running; i++) await scheduler.wait(200);
    }
    if (!container.running) {
      const demo = this.env.DEMO === '1';
      const mail = Boolean(this.env.RESEND_API_KEY && this.env.MAIL_FROM);
      // 映像（Amazon IVS）: チャンネルと AWS の鍵が入っていれば、つなぐ。無ければ、映像なしで競りだけを動かす
      const e = this.env;
      const ivs = Boolean(e.IVS_CHANNEL_ARN && e.IVS_PLAYBACK_URL && e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY);
      const env = {
        POC_TRUST_PROXY: '1',
        POC_COOKIE_SECURE: '1',
        // 公開しているサイトの URL（メールに載せるリンクの先）。設定（SITE_URL）があればそれ。無ければ、最初に届いた通信のアドレス
        ...(e.SITE_URL || this.publicOrigin ? { POC_SITE_URL: e.SITE_URL || this.publicOrigin } : {}),
        ...(ivs ? {
          POC_IVS_MODE: 'aws', IVS_CHANNEL_ARN: e.IVS_CHANNEL_ARN, IVS_PLAYBACK_URL: e.IVS_PLAYBACK_URL, AWS_REGION: e.AWS_REGION || 'ap-northeast-1',
          AWS_ACCESS_KEY_ID: e.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: e.AWS_SECRET_ACCESS_KEY,
          ...(e.EVENTBRIDGE_SECRET ? { POC_EVENTBRIDGE_SECRET: e.EVENTBRIDGE_SECRET } : {}),
          // 配信用PCの配信エージェントの合言葉（報告書 94 章）
          ...(e.AGENT_TOKEN ? { POC_AGENT_TOKEN: e.AGENT_TOKEN } : {}),
        } : { POC_IVS_MODE: 'always-live' }),
        POC_PERSIST_URL: `http://${STORE_HOST}`,
        // 測定の記録は、本番では要点だけにする（詳しい記録は、11分で約 330MB になる。本番運用の評価 C1）
        POC_METRICS: 'basic',
        // お試し用: 認証番号を画面に出し、今日の開催を自動で作る（SMS がまだつながっていないため）
        ...(demo ? { POC_DEV_SHOW_CODES: '1', POC_SETUP_ARGS: '--with-event' } : {}),
        // メールの送信がつながっていれば、実際に送る。SMS は使わない（発注者の決定）ので、本番では、電話番号での認証を止める
        ...(mail ? { POC_MAIL_URL: `http://${MAIL_HOST}` } : {}),
        ...(demo ? {} : { POC_SMS: '0', POC_TOKEN_LOGIN: '0', POC_REQUIRE_SETUP: '1' }),
        // 管理者（admin）の最初のパスワード。ソースには書かず、wrangler secret put ADMIN_PASSWORD で入れる
        ...(this.env.ADMIN_PASSWORD ? { POC_ADMIN_PASSWORD: this.env.ADMIN_PASSWORD } : {}),
        // 最初の主催者管理者のメールアドレス（秘密の値。ソースには書かない）。あれば、起動のときに登録する
        ...(this.env.ADMIN_EMAIL ? { POC_ADMIN_EMAIL: this.env.ADMIN_EMAIL } : {}),
        ...(this.env.ADMIN_EMAIL_SHA256 ? { POC_ADMIN_EMAIL_SHA256: this.env.ADMIN_EMAIL_SHA256 } : {}),
      };
      // コンテナごとに、登録し直す決まり
      await container.interceptOutboundHttp(STORE_HOST, this.ctx.exports.DataStore);
      await container.interceptOutboundHttp(MAIL_HOST, this.ctx.exports.MailSender);
      if (build) await this.ctx.storage.put('build', build);
      container.start({ image: container.images.base, instance: this.env.INSTANCE_TYPE || 'standard-1', enableInternet: ivs, env }); // 外への通信は、IVS の状態を AWS に問い合わせるときだけ開ける
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    const port = container.getTcpPort(PORT);
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        const res = await port.fetch('http://container/healthz', { signal: AbortSignal.timeout(1000) });
        await res.body?.cancel();
        if (res.ok) return;
      } catch { /* まだ待ち受けていない。もう一度確かめる */ }
      await scheduler.wait(200);
    }
    throw new Error('コンテナが、時間内に立ち上がりませんでした');
  }
}

export default {
  // データベースが1つなので、必ず同じ1台（main）へ渡す
  fetch(request, env) {
    // 管理者のパスワードが入るまでは、動かさない（だれも入れない管理者が、消えないデータとして残るのを防ぐ）
    if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 12) {
      return new Response('準備中です。管理者の最初のパスワードを入れてください: npx wrangler secret put ADMIN_PASSWORD（12文字以上）', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return env.AUCTION_APP.getByName('main').fetch(request);
  },
  // 1日1回、アプリを起こす（だれも開かない日にも、支払期限・受け取り期限の知らせを送るため）
  scheduled(controller, env, ctx) {
    if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 12) return;
    ctx.waitUntil(env.AUCTION_APP.getByName('main').fetch(new Request('https://internal/healthz')).then((r) => r.body?.cancel()));
  },
};
