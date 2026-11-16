#!/usr/bin/env node
// テスト用のアカウントをデータベースに入れる（PoC 仕様書 2.2）。名前はすべて架空。本物の個人データは使わない。
// トークン（合言葉）は乱数で作り、data/tokens.json にだけ書く（ソースコードにもチャットにも出さない）。
//   node tools/seed.js --members 100
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '../server/src/config.js';
import { openDb, hashToken } from '../server/src/db.js';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((a) => { const [k, v] = a.trim().split(/[ =]/); return [k, v ?? true]; }));
const members = Number(args.members ?? 100);
const config = loadConfig();
const tokensPath = args.out ?? path.join(config.dataDir, 'tokens.json');

if (fs.existsSync(tokensPath) && !args.force) {
  console.error(`${tokensPath} がすでにあります。作り直すときは --force を付けてください（データベースも空にしてから）。`);
  process.exit(1);
}

const store = openDb(config.dbPath);
const newToken = () => crypto.randomBytes(18).toString('base64url');
const out = { auctioneer: newToken(), agent: newToken(), members: [] };

store.tx(() => {
  store.q.insertStaff.run('auctioneer', 'テスト進行役', hashToken(out.auctioneer));
  store.q.insertStaff.run('agent', '配信エージェント', hashToken(out.agent));
  const base = store.db.prepare('SELECT COALESCE(MAX(paddle_no), 0) AS n FROM members').get().n;
  for (let i = 1; i <= members; i++) {
    const token = newToken();
    const paddle = base + i;
    store.q.insertMember.run(paddle, `テスト会員${String(paddle).padStart(3, '0')}`, hashToken(token));
    out.members.push({ paddle, token });
  }
});
store.db.close();

fs.mkdirSync(path.dirname(tokensPath), { recursive: true });
fs.writeFileSync(tokensPath, JSON.stringify(out, null, 2), { mode: 0o600 });
console.log(`テスト会員 ${members} 人、進行役1人、配信エージェント1つを登録しました。`);
console.log(`トークンは ${tokensPath} に書きました（このファイルは共有・コミットしないでください）。`);
