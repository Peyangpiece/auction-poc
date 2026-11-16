#!/usr/bin/env node
// データベースのバックアップ（本仕様 DATA-004: 1日1回、7世代）。
// サーバーを止めずに取れる（SQLite のオンラインバックアップ）。取ったバックアップは、開けて中身を確かめてから残す。
//   node tools/backup.js                       … data/backups に取り、7世代を残す
//   node tools/backup.js --dir /mnt/backup --keep 14
//   node tools/backup.js --restore data/backups/auction-20261116-030000.db   … 復元（サーバーを止めてから実行する）
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../server/src/config.js';

const argv = process.argv.slice(2);
const arg = (name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : d; };
const config = loadConfig();
const dir = path.resolve(arg('dir', path.join(config.dataDir, 'backups')));
const keep = Number(arg('keep', 7));
const restore = arg('restore', null);

function verify(file) {
  const db = new Database(file, { readonly: true });
  try {
    const ok = db.pragma('integrity_check', { simple: true });
    if (ok !== 'ok') throw new Error(`整合性の確認に失敗しました: ${ok}`);
    return { lots: db.prepare('SELECT COUNT(*) AS n FROM lots').get().n, bids: db.prepare('SELECT COUNT(*) AS n FROM bids').get().n };
  } finally { db.close(); }
}

if (restore) {
  const src = path.resolve(restore);
  const info = verify(src); // 壊れたバックアップでは上書きしない
  if (fs.existsSync(config.dbPath)) {
    const aside = `${config.dbPath}.before-restore-${Date.now()}`;
    fs.renameSync(config.dbPath, aside); // いまのデータベースは消さずに、名前を変えて残す
    for (const ext of ['-wal', '-shm']) fs.rmSync(config.dbPath + ext, { force: true });
    console.log(`いまのデータベースを ${aside} に残しました。`);
  }
  fs.copyFileSync(src, config.dbPath);
  console.log(`復元しました: ${src} → ${config.dbPath}（品 ${info.lots} 件、入札 ${info.bids} 件）`);
  process.exit(0);
}

if (!fs.existsSync(config.dbPath)) { console.error(`データベースがありません: ${config.dbPath}`); process.exit(1); }
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const dest = path.join(dir, `auction-${stamp}.db`);
const tmp = dest + '.partial';
const db = new Database(config.dbPath, { readonly: true });
await db.backup(tmp);
db.close();
const info = verify(tmp);
fs.renameSync(tmp, dest); // 確かめ終わってから、正式な名前にする（途中で止まった分を、バックアップと見間違えない）
console.log(`バックアップを取りました: ${dest}（品 ${info.lots} 件、入札 ${info.bids} 件）`);

// 古い世代を消す
const old = fs.readdirSync(dir).filter((f) => /^auction-\d{8}-\d{6}\.db$/.test(f)).sort().reverse().slice(keep);
for (const f of old) { fs.rmSync(path.join(dir, f)); console.log(`古い世代を消しました: ${f}`); }
