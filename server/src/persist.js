// データの置き場が消える環境（Cloudflare のコンテナなど）のための、外の保存先への保存と復元。
// POC_PERSIST_URL があるときだけ動く。保存先とは、次の4つの通信だけで話す:
//   GET /manifest → { files: [{ path, size }] }　　GET /file/<path>　　PUT /file/<path>　　DELETE /file/<path>
// データベースは、動かしたまま整合の取れた写し（オンラインバックアップ）を取り、圧縮して送る。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip); // 圧縮は、別の糸で行う（競りの最中に、入札の処理を止めない）

export const DB_KEY = 'db/auction.db.gz';
const HISTORY_PREFIX = 'history/';
const HISTORY_DAYS = 35;
// 保存しないもの: データベースの本体（写しを別に送る）、計測の記録、作業用のファイル
// 保存先に送らないもの。送ったメールの控え（初期パスワード・認証番号・請求の本文を含む）と、最初の管理者の控えは、
// 個人情報や秘密を含むので、外の保存先に置かない（本番運用の評価 B7。報告書 102 章）
const PRIVATE = (rel) => rel.startsWith('outbox/') || /^staff-initial-.*\.txt$/.test(rel) || rel === 'tokens.json';
const skip = (rel) => PRIVATE(rel) || rel.startsWith('metrics/') || rel.startsWith('backups/') || rel.includes('.persist-') || /\.db(-wal|-shm|-journal)?$/.test(rel);

async function call(base, method, pathname, body) {
  const res = await fetch(base + pathname, { method, body, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`保存先が ${res.status} を返しました（${method} ${pathname}）`);
  return res;
}
const filePath = (rel) => '/file/' + rel.split('/').map(encodeURIComponent).join('/');

function walk(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, base, out);
    else if (ent.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// 起動の前に、保存先からデータを戻す。保存先に届かないときは、例外を投げる
// （空のデータで立ち上がって、保存先の中身を上書きしてしまうのを防ぐ）。
export async function restore(config, { retries = 20, waitMs = 1500, log = console.log } = {}) {
  const base = config.persistUrl;
  let manifest, lastError;
  for (let i = 0; i < retries && !manifest; i++) {
    try { manifest = await (await call(base, 'GET', '/manifest')).json(); } catch (e) { lastError = e; await new Promise((r) => setTimeout(r, waitMs)); }
  }
  if (!manifest) throw new Error(`保存先に届きません: ${lastError?.message}`);
  fs.mkdirSync(config.dataDir, { recursive: true });
  let count = 0;
  const get = async (rel) => Buffer.from(await (await call(base, 'GET', filePath(rel))).arrayBuffer());
  // 1) データベース。壊れていて開けないときは、日ごとの控えの、新しいものから順に試す（起動できないままにしない）
  const history = manifest.files.map((f) => f.path).filter((p) => p.startsWith(HISTORY_PREFIX)).sort().reverse();
  const candidates = [...(manifest.files.some((f) => f.path === DB_KEY) ? [DB_KEY] : []), ...history];
  for (const rel of candidates) {
    let plain;
    try {
      plain = zlib.gunzipSync(await get(rel));
      if (plain.subarray(0, 15).toString('latin1') !== 'SQLite format 3') throw new Error('データベースの形をしていません');
    } catch (e) {
      log(`【注意】保存先のデータベース（${rel}）を開けません: ${e.message}。次の控えを試します`);
      continue;
    }
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(config.dbPath + ext, { force: true });
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    fs.writeFileSync(config.dbPath, plain);
    if (rel !== DB_KEY) log(`【注意】日ごとの控え（${rel}）から戻しました。それより後の書き込みは、入っていません`);
    count++;
    break;
  }
  if (candidates.length && !count) throw new Error('保存先のデータベースと控えの、どれも開けません');
  // 2) そのほかのファイル（請求書など）。8個ずつ、並べて取りに行く（数が増えても、起動が遅くなりにくいように）
  // 前の版で送ってしまった、個人情報や秘密を含むファイルは、戻さずに保存先から消す
  for (const f of manifest.files.filter((x) => PRIVATE(x.path))) {
    await call(base, 'DELETE', filePath(f.path)).then(() => log(`保存先から、秘密を含むファイルを消しました: ${f.path}`)).catch(() => {});
  }
  const rest = manifest.files.filter((f) => f.path !== DB_KEY && !f.path.startsWith(HISTORY_PREFIX) && !PRIVATE(f.path)); // 日ごとの控えは、戻さない
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < rest.length) {
      const f = rest[next++];
      const full = path.resolve(config.dataDir, f.path);
      if (!full.startsWith(path.resolve(config.dataDir) + path.sep)) throw new Error(`保存先に、おかしな名前のファイルがあります: ${f.path}`);
      const buf = await get(f.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buf);
      count++;
    }
  }));
  log(`保存先から ${count} 個のファイルを戻しました`);
  return count;
}

// 動いているあいだ、変わったものを保存先へ送り続ける。
export function createSaver({ db, config, nowMs = () => Date.now(), log = console.error }) {
  const base = config.persistUrl;
  const sent = new Map(); // 送り済みのファイル（名前 → 大きさと更新時刻）
  let sentChanges = -1, sentHistoryAt = 0, running = null, timer = null;
  const state = { enabled: true, lastSavedAt: 0, lastError: null, failingSince: 0 };
  const changes = () => db.prepare('SELECT total_changes() AS n').get().n;

  // 起動のとき: 保存先にすでにあるファイル（大きさが同じもの）は、送り済みとして扱う（戻したばかりのファイルを、全部送り直さない）
  let seeded = false;
  async function seed() {
    const manifest = await (await call(base, 'GET', '/manifest')).json();
    const sizes = new Map(manifest.files.map((f) => [f.path, f.size]));
    for (const rel of fs.existsSync(config.dataDir) ? walk(config.dataDir) : []) {
      if (skip(rel)) continue;
      const st = fs.statSync(path.join(config.dataDir, rel));
      if (sizes.get(rel) === st.size) sent.set(rel, `${st.size}:${st.mtimeMs}`);
    }
    seeded = true;
  }

  async function saveDb() {
    const n = changes();
    if (n === sentChanges) return;
    const tmp = path.join(config.dataDir, `.persist-${process.pid}.db`);
    try {
      await db.backup(tmp);
      const gz = await gzip(await fs.promises.readFile(tmp), { level: 1 });
      await call(base, 'PUT', filePath(DB_KEY), gz);
      sentChanges = n;
      // 日ごとの控え（壊れたとき・まちがえて消したときに、前の日へ戻せるように）。1時間に1回まで
      if (nowMs() - sentHistoryAt > 3600000) {
        const dayOf = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10).replaceAll('-', '');
        await call(base, 'PUT', filePath(`${HISTORY_PREFIX}auction-${dayOf(nowMs())}.db.gz`), gz);
        sentHistoryAt = nowMs();
        // 控えは、35日分を残す。それより古い日のものは、消す（1週間分をさかのぼって消すので、動いていない日があっても、残らない）
        for (let d = HISTORY_DAYS + 1; d <= HISTORY_DAYS + 7; d++) {
          await call(base, 'DELETE', filePath(`${HISTORY_PREFIX}auction-${dayOf(nowMs() - d * 86400000)}.db.gz`)).catch(() => {});
        }
      }
    } finally { fs.rmSync(tmp, { force: true }); }
  }

  async function pass() {
    // 1) データベース。入札・落札が入っているので、いちばん先に送る（ファイルの送信が詰まっても、待たせない）
    await saveDb();
    if (!seeded) await seed();
    // 2) ファイル（請求書・印鑑の画像・送信の控えなど）
    const now = new Set();
    for (const rel of fs.existsSync(config.dataDir) ? walk(config.dataDir) : []) {
      if (skip(rel)) continue;
      now.add(rel);
      const st = fs.statSync(path.join(config.dataDir, rel));
      const sig = `${st.size}:${st.mtimeMs}`;
      if (sent.get(rel) === sig) continue;
      await call(base, 'PUT', filePath(rel), fs.readFileSync(path.join(config.dataDir, rel)));
      sent.set(rel, sig);
    }
    for (const rel of [...sent.keys()]) if (!now.has(rel)) { await call(base, 'DELETE', filePath(rel)); sent.delete(rel); }
    // ファイルを送っているあいだに入った書き込みを、続けて送る
    await saveDb();
  }

  // 1回分の保存。重なって呼ばれたら、動いているものが終わってから、もう1回だけ行う
  function flush() {
    const next = (running ?? Promise.resolve()).then(async () => {
      try {
        await pass();
        state.lastSavedAt = nowMs(); state.lastError = null; state.failingSince = 0;
      } catch (e) {
        state.lastError = String(e.message ?? e);
        state.failingSince ||= nowMs();
        log(`[persist] 保存に失敗しました: ${state.lastError}`);
      }
    });
    running = next;
    next.finally(() => { if (running === next) running = null; });
    return next;
  }

  return {
    flush,
    start() { timer = setInterval(() => { if (!running) flush(); }, config.persistIntervalMs); timer.unref(); flush(); },
    stop() { clearInterval(timer); },
    // まだ送っていない書き込みがあるか
    status: () => ({ ...state, pending: changes() !== sentChanges }),
  };
}
