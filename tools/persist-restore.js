// 起動の前に、外の保存先からデータを戻す（POC_PERSIST_URL があるときだけ）。
// 保存先に届かないときは、失敗で終わる（空のデータで立ち上がって、保存先を上書きしないため）。
import { loadConfig } from '../server/src/config.js';
import { restore } from '../server/src/persist.js';

const config = loadConfig();
if (!config.persistUrl) process.exit(0);
try {
  await restore(config);
} catch (e) {
  console.error(`データを戻せませんでした。起動を止めます: ${e.message}`);
  process.exit(1);
}
