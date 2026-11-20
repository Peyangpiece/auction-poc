// MVP の API の各ファイルが共有する、時間の定数・役割の呼び名・エラーの形（報告書 119 章で、api.js から分けた）

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const OTP_TTL = 5 * MIN;            // 認証番号の有効期限（FR-AUTH-004）
export const OTP_MAX_ATTEMPTS = 5;         // 入力の誤り5回で無効
export const OTP_MAX_FAILS_PER_HOUR = 10; // 送り直しをまたいだ、誤りの上限（1時間）
export const OTP_SENDS_PER_HOUR = 5;       // 同じ番号へ1時間に5回まで
// 会員: 一度ログインしたら、その端末では、ログインを求めない（発注者の指示）。最後に操作してから 400 日で切れる
// （ブラウザがクッキーを覚えておける上限に合わせた。使っているかぎり、延び続ける）
export const MEMBER_IDLE = 400 * DAY;
export const LOGIN_FAIL_MAX = 10;          // ログイン ID とパスワードの誤りが続いたら、しばらく止める
export const LOGIN_LOCK = 15 * MIN;
// 接続元をまたいだ誤りの上限（会員・スタッフ）。同じ接続元からの誤りは、その接続元だけを止める（ほかの人を、締め出させない。報告書 121 章）
export const LOGIN_FAIL_GLOBAL = 50;
export const STAFF_FAIL_GLOBAL = 25;
export const STAFF_LIFETIME = 12 * HOUR;   // スタッフ: 12時間（FR-AUTH-012）
export const REGISTER_LIFETIME = 15 * MIN; // SMS 認証から登録の完了まで
export const LOCK_AFTER = 5;               // パスワードの誤り5回で
export const LOCK_FOR = 15 * MIN;          // 15分ロック
export const ROLE_LABEL = { admin: '主催者管理者', auctioneer: '進行役', caller: 'オークショニア', reception: '受付係', operator: '開発・運営者' };

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
export const bad = (message, extra) => new HttpError(400, message, extra);

// ---- 請求まわり（billing.js と、そこから分けたファイルが使う）
export const PAY = { transfer: '銀行振込', cash: '当日現金' };
export const RECV = { pickup: '現地受け取り', ship: '配送' };
export const FEE_RATE = 5; // 手数料 5%（FR-FEE-001。決定）

/** 日付（YYYY-MM-DD）に日数を足す */
export const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

// CSV の1マス。表計算ソフトが式として動かす文字（= + - @ など）で始まる文字列は、先頭に ' を付けて、ただの文字にする
export const csvCell = (v) => {
  const t = String(v ?? '');
  return `"${(typeof v === 'string' && /^[=+\-@\t\r]/.test(t) ? "'" + t : t).replaceAll('"', '""')}"`;
};

// ---- サイトの URL（メールや QR コードに載せるリンクの頭）。組み立ては、ここだけで行う（報告書 120 章。これまでは、5か所に同じ式があった）
/** この通信が届いたアドレス。手前のプロキシを信用する設定のときだけ、プロキシが付けた名前を使う */
export const requestOrigin = (config, req) => `${req.headers['x-forwarded-proto'] ?? 'http'}://${(config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host}`;
/** 公開しているサイトの URL。設定（POC_SITE_URL）があれば、それ（通信の見出しより、確かなため） */
export const siteOrigin = (config, req) => config.siteUrl || requestOrigin(config, req);
