// データの置き場が消える環境（Cloudflare のコンテナなど）のための、外の保存先への保存と復元。
// POC_PERSIST_URL があるときだけ動く。保存先とは、次の4つの通信だけで話す:
//   GET /manifest → { files: [{ path, size }] }　　GET /file/<path>　　PUT /file/<path>　　DELETE /file/<path>
// データベースは、動かしたまま整合の取れた写し（オンラインバックアップ）を取り、圧縮して送る。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const DB_KEY = 'db/auction.db.gz';
const HISTORY_PREFIX = 'history/';
// 保存しないもの: データベースの本体（写しを別に送る）、計測の記録、作業用のファイル
const skip = (rel) => rel.startsWith('metrics/') || rel.startsWith('backups/') || rel.includes('.persist-') || /\.db(-wal|-shm|-journal)?$/.test(rel);

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
  for (const f of manifest.files) {
    if (f.path.startsWith(HISTORY_PREFIX)) continue; // 日ごとの控えは、戻さない
    const buf = Buffer.from(await (await call(base, 'GET', filePath(f.path))).arrayBuffer());
    if (f.path === DB_KEY) {
      for (const ext of ['', '-wal', '-shm']) fs.rmSync(config.dbPath + ext, { force: true });
      fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
      fs.writeFileSync(config.dbPath, zlib.gunzipSync(buf));
    } else {
      const full = path.resolve(config.dataDir, f.path);
      if (!full.startsWith(path.resolve(config.dataDir) + path.sep)) throw new Error(`保存先に、おかしな名前のファイルがあります: ${f.path}`);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buf);
    }
    count++;
  }
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

  async function pass() {
    // 1) ファイル（請求書・印鑑の画像・送信の控えなど）。先に送る（データベースが、まだ無いファイルを指さないように）
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
    // 2) データベース。前に送ってから書き込みがあったときだけ
    const n = changes();
    if (n !== sentChanges) {
      const tmp = path.join(config.dataDir, `.persist-${process.pid}.db`);
      try {
        await db.backup(tmp);
        const gz = zlib.gzipSync(fs.readFileSync(tmp), { level: 1 });
        await call(base, 'PUT', filePath(DB_KEY), gz);
        sentChanges = n;
        // 日ごとの控え（壊れたとき・まちがえて消したときに、前の日へ戻せるように）。1時間に1回まで
        if (nowMs() - sentHistoryAt > 3600000) {
          const day = new Date(nowMs() + 9 * 3600000).toISOString().slice(0, 10).replaceAll('-', '');
          await call(base, 'PUT', filePath(`${HISTORY_PREFIX}auction-${day}.db.gz`), gz);
          sentHistoryAt = nowMs();
        }
      } finally { fs.rmSync(tmp, { force: true }); }
    }
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
