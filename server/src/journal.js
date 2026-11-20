// 書き込みの控え（ジャーナル）。データの置き場が消える環境（Cloudflare のコンテナ）で、受理した入札や落札を失わないためのもの。
//
// 仕組み:
//   1) データベースへの書き込み（1つの文、または、1つのトランザクション）ごとに、その文と値を控える
//   2) 控えを、すぐに外の保存先へ送る（journal/<通し番号>.json）。届いたら、「ここまでは消えない」と数える
//   3) 利用者への返事（入札の受理・価格の知らせ・API の返事）は、その書き込みの控えが届いてから出す
//   4) 起動のとき: 保存先のデータベースの写し（約2秒ごと）を戻したあと、それより新しい控えを、順番にやり直す
//
// データベースの写しの中に「どこまでの控えが入っているか」（通し番号）を、書き込みと同じトランザクションで記録する。
// これで、同じ書き込みを2回やり直すことも、抜かすことも無い。
//
// 保存先に届かないあいだは、返事を待たせる。待たせすぎると競りが止まるので、決めた時間（既定 3秒）を超えたら、
// 返事を先に出して（守りが弱まった状態）、知らせる。届くようになれば、自動で元に戻る。
import zlib from 'node:zlib';

export const JOURNAL_PREFIX = 'journal/';
const pad = (n) => String(n).padStart(12, '0');
export const journalKey = (first, last) => `${JOURNAL_PREFIX}${pad(first)}-${pad(last)}.json.gz`;
/** ファイルの名前から、通し番号の範囲を読む。控えのファイルでなければ null */
export function parseJournalKey(rel) {
  const m = /^journal\/(\d{12})-(\d{12})\.json\.gz$/.exec(rel);
  return m ? { first: Number(m[1]), last: Number(m[2]) } : null;
}
const META = 'CREATE TABLE IF NOT EXISTS persist_journal (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL)';

// 値を、JSON にできる形にする（バイト列と、大きな整数だけ、印を付ける）
const enc = (v) => (Buffer.isBuffer(v) ? { $b: v.toString('base64') } : typeof v === 'bigint' ? { $n: String(v) }
  : Array.isArray(v) ? v.map(enc) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) : v);
const dec = (v) => (Array.isArray(v) ? v.map(dec) : v && typeof v === 'object'
  ? ('$b' in v ? Buffer.from(v.$b, 'base64') : '$n' in v ? BigInt(v.$n) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]))) : v);

/**
 * データベースに、書き込みを見張る仕組みを付ける（openDb の直後に呼ぶ。文を用意する前に付ける必要がある）。
 * 見張りは、journal.attach() で相手が付くまで、何もしない。
 */
export function installWriteHook(db) {
  if (db.writeHook) return db.writeHook;
  const hook = { sink: null, depth: 0, buffer: [] };
  const prepare = db.prepare.bind(db);
  const transaction = db.transaction.bind(db);
  const begin = prepare('BEGIN IMMEDIATE'), commit = prepare('COMMIT'), rollback = prepare('ROLLBACK');
  const wrap = (stmt, sql) => {
    if (stmt.readonly) return stmt;
    for (const method of ['run', 'get', 'all']) {
      const call = stmt[method].bind(stmt);
      stmt[method] = (...args) => {
        const sink = hook.sink;
        if (!sink) return call(...args);
        if (db.inTransaction) { const r = call(...args); hook.buffer.push([sql, enc(args)]); return r; }
        // トランザクションの外の1文: 通し番号の記録と、ひとまとめにして確定する
        begin.run();
        let r;
        try { r = call(...args); sink.mark(); commit.run(); } catch (e) { if (db.inTransaction) rollback.run(); throw e; }
        sink.committed([[sql, enc(args)]]);
        return r;
      };
    }
    return stmt;
  };
  db.prepare = (sql) => wrap(prepare(sql), sql);
  db.transaction = (fn) => {
    const inner = transaction(function (...args) {
      const mark = hook.buffer.length;
      hook.depth++;
      try {
        const r = fn.apply(this, args);
        // いちばん外のトランザクションが確定する直前に、通し番号を記録する
        if (hook.depth === 1 && hook.sink && hook.buffer.length) hook.sink.mark();
        return r;
      } catch (e) { hook.buffer.length = mark; throw e; } finally { hook.depth--; }
    });
    return (...args) => {
      const r = inner(...args);
      if (hook.depth === 0 && hook.buffer.length) { const done = hook.buffer; hook.buffer = []; hook.sink?.committed(done); }
      return r;
    };
  };
  hook.raw = { prepare };
  db.writeHook = hook;
  return hook;
}

/** いまのデータベースに入っている、控えの通し番号（無ければ 0） */
export function journalSeq(db) {
  const prepare = db.writeHook?.raw.prepare ?? db.prepare.bind(db);
  if (!prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'persist_journal'").get()) return 0;
  return prepare('SELECT seq FROM persist_journal WHERE id = 1').get()?.seq ?? 0;
}

/**
 * 起動の前: 戻したデータベースに、それより新しい控えを、順番にやり直す。
 * @param db   戻したデータベース（見張りを付けていない、素のもの）
 * @param files 保存先にある控えのファイル [{ rel, first, last }]
 * @param get  ファイルを取る関数（rel → Buffer）
 * @returns { applied, seq, stoppedAt }
 */
export async function replayJournal(db, files, get, { log = console.log } = {}) {
  db.exec(META);
  db.prepare('INSERT OR IGNORE INTO persist_journal (id, seq) VALUES (1, 0)').run();
  let seq = db.prepare('SELECT seq FROM persist_journal WHERE id = 1').get().seq;
  const setSeq = db.prepare('UPDATE persist_journal SET seq = ? WHERE id = 1');
  const todo = files.filter((f) => f.last > seq).sort((a, b) => a.first - b.first);
  let applied = 0;
  const cache = new Map();
  const stmt = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = db.prepare(sql))); return s; };
  for (const f of todo) {
    const entries = JSON.parse(zlib.gunzipSync(await get(f.rel)).toString('utf8'));
    for (const e of entries) {
      if (e.seq <= seq) continue;
      // 番号が飛んでいたら、そこで止める（あいだの書き込みが無いまま、先をやり直すと、つじつまが合わなくなる）
      if (e.seq !== seq + 1) { log(`【注意】書き込みの控えが、${seq} の次で途切れています（次にあるのは ${e.seq}）。ここまでを戻しました`); return { applied, seq, stoppedAt: e.seq }; }
      try {
        db.transaction(() => {
          for (const [sql, args] of e.ops) { const s = stmt(sql); const a = dec(args); if (s.reader) s.all(...a); else s.run(...a); }
          setSeq.run(e.seq);
        })();
      } catch (err) {
        log(`【注意】書き込みの控え ${e.seq} を、やり直せませんでした（${err.message}）。ここまでを戻しました`);
        return { applied, seq, stoppedAt: e.seq };
      }
      seq = e.seq; applied++;
    }
  }
  return { applied, seq, stoppedAt: null };
}

/**
 * 動いているあいだ: 書き込みを控えて、保存先へ送る。
 * @param put (rel, Buffer) → Promise。保存先へ置く
 * @param del (rel) → Promise。保存先から消す
 */
export function createJournal({ db, put, del, nowMs = () => Date.now(), log = console.error, maxWaitMs = 3000, onDegraded = () => {} }) {
  const hook = installWriteHook(db);
  const raw = hook.raw.prepare;
  db.exec(META);
  raw('INSERT OR IGNORE INTO persist_journal (id, seq) VALUES (1, 0)').run();
  let seq = raw('SELECT seq FROM persist_journal WHERE id = 1').get().seq; // 確定した書き込みの、いちばん新しい番号
  let acked = seq;                                                         // 保存先に届いた、いちばん新しい番号
  const setSeq = raw('UPDATE persist_journal SET seq = ? WHERE id = 1');
  let pending = [];      // まだ送っていない書き込み
  let shipping = false, degraded = false, failingSince = 0, lastError = null, stopped = false;
  const shipped = [];    // 保存先にある控えのファイル（写しに入ったら消す）
  const waiters = [];    // { seq, fn }: その番号まで届いたら呼ぶ

  const release = () => {
    while (waiters.length && (degraded || waiters[0].seq <= acked)) { const w = waiters.shift(); try { w.fn(); } catch (e) { log(`[journal] ${e?.message ?? e}`); } }
  };
  async function ship() {
    if (shipping || stopped) return;
    shipping = true;
    try {
      while (pending.length) {
        const batch = pending; pending = [];
        const first = batch[0].seq, last = batch.at(-1).seq, rel = journalKey(first, last);
        const body = zlib.gzipSync(JSON.stringify(batch), { level: 1 });
        for (;;) {
          try { await put(rel, body); break; } catch (e) {
            lastError = String(e?.message ?? e);
            failingSince ||= nowMs();
            // 待たせすぎない: 決めた時間を超えたら、返事を先に出して、知らせる（届くまで、送り直しは続ける）
            if (!degraded && nowMs() - failingSince >= maxWaitMs) { degraded = true; log(`[journal] 保存先に届きません（${lastError}）。返事を先に出します`); onDegraded(true, lastError); release(); }
            if (stopped) return;
            await new Promise((r) => setTimeout(r, 300));
          }
        }
        shipped.push({ rel, last });
        acked = last;
        if (failingSince) { failingSince = 0; lastError = null; if (degraded) { degraded = false; onDegraded(false, null); } }
        release();
      }
    } finally { shipping = false; }
  }

  const sink = {
    // 通し番号の記録（書き込みと同じトランザクションの中で呼ばれる）
    mark() { setSeq.run(seq + 1); },
    // 確定した書き込み
    committed(ops) { seq++; pending.push({ seq, at: nowMs(), ops }); queueMicrotask(ship); },
  };

  return {
    /** 見張りを始める（起動のときの準備の書き込みが終わってから呼ぶ。それまでの書き込みは、最初の写しに入る） */
    start() { if (!stopped) hook.sink = sink; },
    /** いまの番号（確定したもの） */
    get seq() { return seq; },
    /** すべての書き込みが、保存先に届いているか */
    clean: () => acked >= seq && waiters.length === 0,
    /** いまの書き込みまでが届いたら、fn を呼ぶ（届いていれば、すぐ呼ぶ）。呼ばれる順は、頼んだ順 */
    after(fn) { if (degraded || (acked >= seq && waiters.length === 0)) return fn(); waiters.push({ seq, fn }); },
    /** いまの書き込みまでが届くのを待つ */
    durable() { return new Promise((resolve) => this.after(resolve)); },
    /** データベースの写しに、番号 upto までが入った。それより前の控えを、保存先から消す */
    async prune(upto) {
      while (shipped.length && shipped[0].last <= upto) { const f = shipped.shift(); await del(f.rel).catch(() => {}); }
    },
    status: () => ({ seq, acked, waiting: waiters.length, degraded, failingSince, lastError }),
    /** 止める前に、残りを送る */
    async flush(timeoutMs = 10000) { const end = nowMs() + timeoutMs; queueMicrotask(ship); while (acked < seq && nowMs() < end) await new Promise((r) => setTimeout(r, 50)); return acked >= seq; },
    stop() { stopped = true; hook.sink = null; degraded = true; release(); },
  };
}
