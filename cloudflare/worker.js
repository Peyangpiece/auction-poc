// Cloudflare の入口（Worker）。届いた通信を、そのまま、アプリの入ったコンテナ（1台）へ渡す。
// 画面・API・WebSocket（入札）のすべてが、ここを通る。配り方は docs/03 の 32 章。
import { DurableObject } from 'cloudflare:workers';

const PORT = 8080;
// 通信が途絶えてから、コンテナを止めるまでの時間。止まると、中のデータは消える（お試し用のため）
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

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
    if (!container.running) {
      const demo = this.env.DEMO === '1';
      const env = {
        POC_TRUST_PROXY: '1',
        POC_COOKIE_SECURE: '1',
        POC_IVS_MODE: 'always-live',
        // お試し用: 認証番号を画面に出し、今日の開催を自動で作る（SMS がまだつながっていないため）
        ...(demo ? { POC_DEV_SHOW_CODES: '1', POC_SETUP_ARGS: '--with-event' } : {}),
        // 管理者（admin）の最初のパスワード。ソースには書かず、wrangler secret put ADMIN_PASSWORD で入れる
        ...(this.env.ADMIN_PASSWORD ? { POC_ADMIN_PASSWORD: this.env.ADMIN_PASSWORD } : {}),
      };
      container.start({ image: container.images.base, instance: this.env.INSTANCE_TYPE || 'basic', enableInternet: false, env });
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
    return env.AUCTION_APP.getByName('main').fetch(request);
  },
};
