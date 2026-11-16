// 測定のための記録（POC-SRV-007・008、POC-IVS-002）。
// 1行1件の JSON（NDJSON）で追記する。入札の正本はデータベースで、ここは測定専用。
// 落としても競りの結果には影響しないので、fsync はしない（入札の応答時間を測定が悪化させないため）。
import fs from 'node:fs';
import path from 'node:path';
import { nowMs } from './clock.js';

export class Metrics {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.file = path.join(dir, `metrics-${stamp}-${process.pid}.ndjson`);
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    this.write('server_start', { pid: process.pid });
  }

  write(type, data = {}) {
    this.stream.write(JSON.stringify({ type, at: nowMs(), ...data }) + '\n');
  }

  close() {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}
