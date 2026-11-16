// MVP の 1（会員登録・認証・スタッフ）と、開催・主催者設定・監査ログのデータ。商品は進行コンソールからその場で登録する（PoC の lots）。
// PoC の入札用の表（members・staff・lots・bids）とは別に持つ。入札との結び付け（参加手続き・参加番号）は MVP の 3 で行う。
export const MVP_SCHEMA = `
-- 会員（FR-AUTH-001・002・003・009・011）
CREATE TABLE IF NOT EXISTS member_accounts (
  id INTEGER PRIMARY KEY,                 -- 会員番号（登録の順。画面には出さない。FR-NUM-001）
  kind TEXT NOT NULL CHECK (kind IN ('b2b','b2c')),
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,             -- 1つの電話番号で登録できる会員は1人（FR-AUTH-001）
  email TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  address TEXT NOT NULL,
  ship_to TEXT,                           -- 配送先（任意）
  company TEXT, contact_name TEXT, billing TEXT,   -- 法人の追加項目
  adult_declared INTEGER NOT NULL DEFAULT 0,       -- 個人の「18歳以上」の申告（FR-AUTH-003）
  suspended INTEGER NOT NULL DEFAULT 0,   -- 手動の停止（FR-AUTH-009）
  suspend_reason TEXT,
  created_at REAL NOT NULL, updated_at REAL NOT NULL
);
-- スタッフ（FR-AUTH-012）
CREATE TABLE IF NOT EXISTS staff_accounts (
  id INTEGER PRIMARY KEY,
  login_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','auctioneer','reception')),  -- 主催者管理者・進行役・受付係
  phone TEXT,                             -- この番号では会員登録できない（FR-AUTH-013）
  password_hash TEXT NOT NULL,
  totp_secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until REAL NOT NULL DEFAULT 0,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,               -- クッキーの値そのものは保存しない
  kind TEXT NOT NULL CHECK (kind IN ('member','staff','register')),
  subject_id INTEGER,
  phone TEXT,                             -- 登録の途中（SMS 認証が済んだ番号）
  created_at REAL NOT NULL, last_seen_at REAL NOT NULL
);
-- SMS の認証番号（FR-AUTH-004）
CREATE TABLE IF NOT EXISTS otp_codes (
  phone TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS otp_sends (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS otp_sends_phone ON otp_sends(phone, at);
CREATE TABLE IF NOT EXISTS email_tokens (token_hash TEXT PRIMARY KEY, member_id INTEGER NOT NULL, expires_at REAL NOT NULL);

-- 開催（FR-EVT-001・002）
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,   -- 日本時間の日時（例: 2026-12-05T09:00）
  venue_name TEXT NOT NULL, venue_address TEXT NOT NULL,
  highlights TEXT NOT NULL DEFAULT '',     -- 目玉商品（1行に1つ。トップページに出す）
  notified INTEGER NOT NULL DEFAULT 0,    -- 公安委員会への届出済みの印
  status TEXT NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing','published')),
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- 主催者管理者への知らせ（送信の失敗など）
CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY, at REAL NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);

-- 監査ログ。追記だけ（DATA-001）
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL, at REAL NOT NULL,
  actor_kind TEXT NOT NULL, actor_id INTEGER, actor_role TEXT,   -- システムが自動で行ったものは 'system'
  target TEXT NOT NULL DEFAULT '', before TEXT, after TEXT, reason TEXT, ip TEXT
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log は追記だけ'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log は追記だけ'); END;
`;

// 既定の文言。法務の確認が済んでいないので、どれも仮のもの（本仕様 FR-LEG-002、OQ-22 は【要確認】）
export const DEFAULT_SETTINGS = {
  org_name: '株式会社NEWS',
  return_policy: '【仮の文言。弁護士の確認前】中古品のため、現状でのお渡しとなります。落札後の返品・交換はお受けできません。',
  shipping_notice: '落札価格に送料は含まれません。配送の場合、送料は後日、別にご請求します。',
};
