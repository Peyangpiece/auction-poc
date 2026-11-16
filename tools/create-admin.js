// 最初の主催者管理者（スタッフ）を作る。2人目からは、管理画面の「スタッフ」で作る。
//   node tools/create-admin.js --id admin --name "管理者の名前"
// 仮のパスワードと、認証アプリに登録する鍵は、画面には出さない。データの置き場のファイルに、持ち主だけが読める形で書き出す。
// 登録を済ませたら、そのファイルは消すこと。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../server/src/config.js';
import { openDb } from '../server/src/db.js';
import { createApi } from '../server/src/mvp/api.js';

const { values } = parseArgs({ options: { id: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'admin' }, phone: { type: 'string' } } });
if (!values.id || !values.name) {
  console.error('使い方: node tools/create-admin.js --id <ログイン ID> --name <名前> [--role admin|auctioneer|reception] [--phone <電話番号>]');
  process.exit(2);
}
const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });
const store = openDb(config.dbPath);
const api = createApi({ store, config, nowMs: () => Date.now() });
try {
  const created = api.createStaff({ loginId: values.id, name: values.name, role: values.role, phone: values.phone });
  api.audit({ system: true }, 'staff.create', { target: `staff:${created.id}`, after: { loginId: created.loginId, role: created.role, by: 'tools/create-admin.js' } });
  const file = path.join(config.dataDir, `staff-initial-${created.loginId}.txt`);
  fs.writeFileSync(file, [
    `ログイン ID: ${created.loginId}`,
    `仮のパスワード: ${created.initialPassword}`,
    `認証アプリの鍵: ${created.totpSecret}`,
    `認証アプリ用の URL: ${created.otpauthUrl}`,
    '',
  ].join('\n'), { mode: 0o600 });
  console.log(`作りました。ログインに使う情報は、次のファイルにあります（登録が済んだら消してください）:\n${file}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  store.db.close();
}
