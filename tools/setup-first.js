// はじめて動かすときの準備: 最初の主催者管理者と、今日の開催（お試し用）を作る。すでにあれば、何もしない。
//   node tools/setup-first.js [--with-event]
// 管理者の仮のパスワードと認証アプリの鍵は、画面には出さず、data/staff-initial-admin.txt に書き出す。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../server/src/config.js';
import { openDb } from '../server/src/db.js';
import { createApi } from '../server/src/mvp/api.js';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });
const store = openDb(config.dbPath);
const api = createApi({ store, config, nowMs: () => Date.now() });
if (!store.db.prepare('SELECT 1 FROM staff_accounts LIMIT 1').get()) {
  // 置き場が消える環境（Cloudflare のコンテナなど）では、ファイルを読みに行けないので、最初のパスワードを環境変数で受け取れる
  const password = process.env.POC_ADMIN_PASSWORD || undefined;
  if (password && password.length < 12) { console.error('POC_ADMIN_PASSWORD は、12文字以上にしてください'); process.exit(1); }
  const s = api.createStaff({ loginId: 'admin', name: '管理者', role: 'admin', password });
  api.audit({ system: true }, 'staff.create', { target: `staff:${s.id}`, after: { loginId: s.loginId, role: s.role, by: 'tools/setup-first.js' } });
  const file = path.join(config.dataDir, 'staff-initial-admin.txt');
  fs.writeFileSync(file, [`ログイン ID: ${s.loginId}`, `仮のパスワード: ${password ? '（環境変数 POC_ADMIN_PASSWORD で指定したもの）' : s.initialPassword}`, `認証アプリの鍵: ${s.totpSecret}`, `認証アプリ用の URL: ${s.otpauthUrl}`, ''].join('\n'), { mode: 0o600 });
  console.log(`最初の主催者管理者（admin）を作りました。ログインに使う情報: ${file}`);
} else console.log('スタッフは、すでに登録されています。');
if (process.argv.includes('--with-event') && !store.db.prepare('SELECT 1 FROM events LIMIT 1').get()) {
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  store.db.prepare("INSERT INTO events (title, starts_at, ends_at, venue_name, venue_address, highlights, notified, venue_code, status, created_at) VALUES (?,?,?,?,?,?,1,?, 'published', ?)")
    .run('お試しの開催', `${today}T09:00`, `${today}T23:59`, '（例）会場', '（例）住所', '（例）目玉商品', Math.random().toString(36).slice(2, 14), Date.now());
  console.log('今日の開催（お試し用）を、公開の状態で作りました。');
}
store.db.close();
