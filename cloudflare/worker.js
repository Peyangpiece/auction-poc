// Cloudflare の入口（Worker）。届いた通信を、そのまま、アプリの入ったコンテナ（1台）へ渡す。
// 画面・API・WebSocket（入札）のすべてが、ここを通る。配り方は docs/03 の 32 章。
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { handleStore } from './store.js';

const PORT = 8080;
// コンテナの中のアプリが、データの保存先（R2）を呼ぶときの名前。外のインターネットには出ない
const STORE_HOST = 'store.internal';
// 通信が途絶えてから、コンテナを止めるまでの時間。止まっても、データは R2 から戻る
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

// コンテナからの「保存先」あての通信を受けて、R2 に出し入れする
export class DataStore extends WorkerEntrypoint {
  fetch(request) {
    return handleStore(request, this.env.DATA);
  }
}

export class AuctionApp extends DurableObject {
  starting;

  constructor(ctx, env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
  }

  async fetch(request) {
    // 同時に届いた通信は、1回の起動を待ち合わせる
    this.starting ??= this.startAndWait().finally(() => { this.starting = undefined; });
    await this.starting;
    const url = new URL(request.url);
    const publicHost = url.host;
    url.protocol = 'http:';
    url.host = 'container';
    const forwarded = new Request(url, request);
    forwarded.headers.delete('host');
    // 外から見たサイトの名前と HTTPS であることを、アプリへ伝える（外から届いた同名のヘッダーは、ここで上書きする）
    forwarded.headers.set('x-forwarded-host', publicHost);
    forwarded.headers.set('x-forwarded-proto', 'https');
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
      const env = {
        POC_TRUST_PROXY: '1',
        POC_COOKIE_SECURE: '1',
        POC_IVS_MODE: 'always-live',
        POC_PERSIST_URL: `http://${STORE_HOST}`,
        // お試し用: 認証番号を画面に出し、今日の開催を自動で作る（SMS がまだつながっていないため）
        ...(demo ? { POC_DEV_SHOW_CODES: '1', POC_SETUP_ARGS: '--with-event' } : {}),
        // 管理者（admin）の最初のパスワード。ソースには書かず、wrangler secret put ADMIN_PASSWORD で入れる
        ...(this.env.ADMIN_PASSWORD ? { POC_ADMIN_PASSWORD: this.env.ADMIN_PASSWORD } : {}),
      };
      // コンテナごとに、登録し直す決まり
      await container.interceptOutboundHttp(STORE_HOST, this.ctx.exports.DataStore);
      if (build) await this.ctx.storage.put('build', build);
      container.start({ image: container.images.base, instance: this.env.INSTANCE_TYPE || 'standard-1', enableInternet: false, env });
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
};
