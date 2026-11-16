// データベース（SQLite）。入札は、ここへの書き込み（fsync つきのコミット）が終わってから「受理」と返す（NFR-REL-001）。
// better-sqlite3 は同期 API なので、1件の処理の途中に別の入札の処理が割り込むことがない（FR-BID-004 の直列処理をそのまま保証できる）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  paddle_no INTEGER NOT NULL,             -- 参加番号（画面にはこの番号だけを出す。FR-BID-008）。開催ごとに1から振る（FR-NUM-001）
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,        -- 検証用の合言葉。会員の参加（account_id あり）では使わない乱数を入れる
  account_id INTEGER,                     -- 登録した会員（member_accounts.id）。検証用の参加者では NULL
  event_id INTEGER,                       -- 参加した開催（events.id）。検証用の参加者では NULL
  receive TEXT,                           -- 受け取り方法: pickup（現地受け取り）/ ship（配送）（FR-SHIP-007）
  payment TEXT,                           -- 支払方法: transfer（銀行振込）/ cash（当日現金）（FR-PAY-009）
  mode TEXT NOT NULL DEFAULT 'online',    -- 参加モード（FR-MODE-001）。会場参加は MVP の 4
  joined_at REAL
);
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('auctioneer','agent')),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS lots (
  id INTEGER PRIMARY KEY,
  lot_no INTEGER NOT NULL,                -- 開催ごとに、登録の順に1から振る（FR-NUM-001）
  event_id INTEGER,                       -- 開催（events.id）。開催なしで動かす検証では NULL
  title TEXT NOT NULL,
  start_price INTEGER NOT NULL CHECK (start_price > 0),   -- 税込（FR-BID-010）
  unit_override INTEGER,                                    -- 商品ごとの入札単位の上書き（FR-BID-005）
  reserve_price INTEGER,                                    -- 最低落札額（全員に公開する。なければ NULL）
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting','preparing','preparing_warn','open','suspended','sold','unsold','not_held')),
  prep_from TEXT,                 -- 配信準備中に入る前の状態（waiting / suspended）
  no_video INTEGER NOT NULL DEFAULT 0,
  current_bid_seq INTEGER,        -- 現在の最高入札（受理された有効な入札）の受付連番。なければ NULL
  close_seq INTEGER,              -- 「締め」の受付連番
  winner_bid_seq INTEGER,
  updated_at REAL NOT NULL
);
-- すべての入札（受理も拒否も）。受付連番 seq が順番の唯一の根拠（FR-BID-004）。
CREATE TABLE IF NOT EXISTS bids (
  seq INTEGER PRIMARY KEY,
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  member_id INTEGER NOT NULL REFERENCES members(id),
  amount INTEGER NOT NULL,
  received_at REAL NOT NULL,      -- サーバーが受け付けた時刻（UTC エポックミリ秒）
  result TEXT NOT NULL,           -- 'ACCEPTED' または FR-BID-012 の理由コード
  valid INTEGER NOT NULL DEFAULT 1,  -- 取りやめで無効になったら 0（記録は消さない。FR-BID-007）
  void_reason TEXT
);
CREATE INDEX IF NOT EXISTS bids_lot ON bids(lot_id, seq);
-- ロットの出来事（締め・状態の変化）。追記だけ（DATA-001）。入札と同じ受付連番の系列を使う。
CREATE TABLE IF NOT EXISTS lot_events (
  seq INTEGER PRIMARY KEY,
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  type TEXT NOT NULL,
  at REAL NOT NULL,
  actor TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS lot_events_lot ON lot_events(lot_id, seq);
-- コメント（参加者が映像の横に書き込む短い文。20文字まで）。削除はせず、非表示の印を付ける。
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  lot_id INTEGER REFERENCES lots(id),
  member_id INTEGER NOT NULL REFERENCES members(id),
  body TEXT NOT NULL,
  at REAL NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER IF NOT EXISTS lot_events_no_update BEFORE UPDATE ON lot_events
  BEGIN SELECT RAISE(ABORT, 'lot_events は追記だけ'); END;
CREATE TRIGGER IF NOT EXISTS lot_events_no_delete BEFORE DELETE ON lot_events
  BEGIN SELECT RAISE(ABORT, 'lot_events は追記だけ'); END;
CREATE TRIGGER IF NOT EXISTS bids_no_delete BEFORE DELETE ON bids
  BEGIN SELECT RAISE(ABORT, 'bids は削除できない'); END;
`;

const INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS members_event_paddle ON members(COALESCE(event_id, 0), paddle_no);
CREATE UNIQUE INDEX IF NOT EXISTS members_event_account ON members(event_id, account_id);
CREATE UNIQUE INDEX IF NOT EXISTS lots_event_no ON lots(COALESCE(event_id, 0), lot_no);
`;

/**
 * 以前の版のデータベースを、いまの形に直す。
 * members.paddle_no と lots.lot_no に付いていた「全体で1つ」の制約を外すには、表を作り直すしかない（SQLite の制約）。
 * 行の id は変えないので、入札などからの参照はそのまま生きる。
 */
function migrate(db) {
  const has = (table, col) => !!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col);
  const defs = Object.fromEntries([...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)].map((m) => [m[1], m[2]]));
  const rebuild = (table, keep) => {
    db.exec(`CREATE TABLE ${table}_new (${defs[table]}\n);
      INSERT INTO ${table}_new (${keep}) SELECT ${keep} FROM ${table};
      DROP TABLE ${table};
      ALTER TABLE ${table}_new RENAME TO ${table};`);
  };
  const todo = [];
  if (!has('lots', 'reserve_price')) db.exec('ALTER TABLE lots ADD COLUMN reserve_price INTEGER');
  if (!has('members', 'account_id')) todo.push(['members', 'id, paddle_no, name, token_hash']);
  if (!has('lots', 'event_id')) todo.push(['lots', 'id, lot_no, title, start_price, unit_override, reserve_price, status, prep_from, no_video, current_bid_seq, close_seq, winner_bid_seq, updated_at']);
  if (!todo.length) return;
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON'); // 名前を戻すときに、ほかの表からの参照を書き換えさせない
  db.transaction(() => { for (const [table, keep] of todo) rebuild(table, keep); })();
  db.pragma('legacy_alter_table = OFF');
  db.pragma('foreign_keys = ON');
}

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL'); // コミットごとに fsync する。電源断でも受理済みの入札を失わない
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  db.exec(INDEXES);

  const q = {
    lot: db.prepare(`
      SELECT l.*, b.amount AS current_price, b.member_id AS highest_member_id, m.paddle_no AS highest_paddle
      FROM lots l
      LEFT JOIN bids b ON b.seq = l.current_bid_seq
      LEFT JOIN members m ON m.id = b.member_id
      WHERE l.id = ?`),
    lots: db.prepare(`
      SELECT l.*, b.amount AS current_price, b.member_id AS highest_member_id, m.paddle_no AS highest_paddle
      FROM lots l
      LEFT JOIN bids b ON b.seq = l.current_bid_seq
      LEFT JOIN members m ON m.id = b.member_id
      WHERE l.event_id IS ?
      ORDER BY l.lot_no`),
    busyLot: db.prepare(
      `SELECT id FROM lots WHERE status IN ('preparing','preparing_warn','open','suspended') AND id <> ? LIMIT 1`),
    activeLots: db.prepare(`SELECT id, status FROM lots WHERE status IN ('preparing','preparing_warn','open','suspended')`),
    insertBid: db.prepare(
      `INSERT INTO bids (seq, lot_id, member_id, amount, received_at, result) VALUES (?, ?, ?, ?, ?, ?)`),
    setCurrentBid: db.prepare(`UPDATE lots SET current_bid_seq = ?, updated_at = ? WHERE id = ?`),
    insertEvent: db.prepare(
      `INSERT INTO lot_events (seq, lot_id, type, at, actor, data) VALUES (?, ?, ?, ?, ?, ?)`),
    setStatus: db.prepare(`UPDATE lots SET status = ?, prep_from = ?, no_video = ?, updated_at = ? WHERE id = ?`),
    finalize: db.prepare(
      `UPDATE lots SET status = ?, close_seq = ?, winner_bid_seq = ?, updated_at = ? WHERE id = ?`),
    voidBids: db.prepare(`UPDATE bids SET valid = 0, void_reason = ? WHERE lot_id = ? AND valid = 1`),
    clearCurrentBid: db.prepare(`UPDATE lots SET current_bid_seq = NULL WHERE id = ?`),
    // 画面に出す履歴は、受理された入札の全件（無効になったものは取り消し線用に valid=0 で返す）。受付連番の順。
    history: db.prepare(`
      SELECT b.seq, b.amount, b.received_at, b.valid, m.paddle_no AS paddle
      FROM bids b JOIN members m ON m.id = b.member_id
      WHERE b.lot_id = ? AND b.result = 'ACCEPTED' ORDER BY b.seq`),
    allBids: db.prepare(`
      SELECT b.seq, b.amount, b.received_at, b.result, b.valid, m.paddle_no AS paddle
      FROM bids b JOIN members m ON m.id = b.member_id WHERE b.lot_id = ? ORDER BY b.seq`),
    events: db.prepare(`SELECT seq, type, at, actor, data FROM lot_events WHERE lot_id = ? ORDER BY seq`),
    lastEvent: db.prepare(`SELECT seq, type FROM lot_events WHERE lot_id = ? ORDER BY seq DESC LIMIT 1`),
    maxSeq: db.prepare(
      `SELECT MAX(s) AS s FROM (SELECT MAX(seq) AS s FROM bids UNION ALL SELECT MAX(seq) AS s FROM lot_events)`),
    memberByToken: db.prepare(`SELECT id, paddle_no, name, account_id FROM members WHERE token_hash = ? AND account_id IS NULL`),
    staffByToken: db.prepare(`SELECT id, role, name FROM staff WHERE token_hash = ?`),
    insertLot: db.prepare(
      `INSERT INTO lots (lot_no, event_id, title, start_price, unit_override, reserve_price, updated_at)
       VALUES ((SELECT COALESCE(MAX(lot_no), 0) + 1 FROM lots WHERE event_id IS @event), @event, @title, @start, @unit, @reserve, @at)`),
    insertMember: db.prepare(`INSERT INTO members (paddle_no, name, token_hash) VALUES (?, ?, ?)`),
    insertComment: db.prepare(`INSERT INTO comments (lot_id, member_id, body, at) VALUES (?, ?, ?, ?)`),
    hideComment: db.prepare(`UPDATE comments SET hidden = 1 WHERE id = ?`),
    recentComments: db.prepare(`
      SELECT * FROM (
        SELECT c.id, c.body AS text, c.at, m.paddle_no AS paddle
        FROM comments c JOIN members m ON m.id = c.member_id WHERE c.hidden = 0 ORDER BY c.id DESC LIMIT 30
      ) ORDER BY id`),
    insertStaff: db.prepare(`INSERT INTO staff (role, name, token_hash) VALUES (?, ?, ?)`),
  };
  return { db, q, tx: (fn) => db.transaction(fn)() };
}
