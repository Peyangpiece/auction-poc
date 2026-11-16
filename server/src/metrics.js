// 測定のための記録（POC-SRV-007・008、POC-IVS-002）。
// 1行1件の JSON（NDJSON）で追記する。入札の正本はデータベースで、ここは測定専用。
// 落としても競りの結果には影響しないので、fsync はしない（入札の応答時間を測定が悪化させないため）。
//
// 際限なく増えないようにする:
//   ・level   … full（すべて）／basic（端末ごとの送り返しを除く）／off（記録しない）
//   ・fileMb  … 1ファイルがこの大きさを超えたら、次のファイルに切り替える
//   ・maxMb   … フォルダ全体がこの大きさを超えたら、古いファイルから消す
import fs from 'node:fs';
import path from 'node:path';
import { nowMs } from './clock.js';

// 端末の数 × 入札の数だけ増える、件数の多い記録
const PER_CLIENT = new Set(['price_ack', 'result_ack', 'video_latency']);

export class Metrics {
  constructor(dir, { level = 'full', fileMb = 64, maxMb = 1024 } = {}) {
    this.dir = dir;
    this.level = level;
    this.fileBytes = fileMb * 1048576;
    this.maxBytes = maxMb * 1048576;
    this.part = 0;
    this.written = 0;
    this.stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.file = null;
    this.stream = null;
    if (level === 'off') return;
    fs.mkdirSync(dir, { recursive: true });
    this.#open();
    this.write('server_start', { pid: process.pid, level });
  }

  #open() {
    this.file = path.join(this.dir, `metrics-${this.stamp}-${process.pid}-${String(this.part).padStart(3, '0')}.ndjson`);
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    this.written = 0;
    this.#prune();
  }

  /**
   * フォルダ全体が上限を超えていたら、古いファイルから消す（いま書いているファイルは消さない）。
   * この実行で書いたファイルの大きさは、自分で数えた値を使う。
   * 書き込みは非同期なので、ディスク上の大きさを見ると、まだ書き終わっていない分が小さく見えるため。
   */
  #prune() {
    if (!this.known) {
      // 起動時に、以前の実行が残したファイルを古い順に控える
      this.known = [];
      try {
        this.known = fs.readdirSync(this.dir).filter((f) => f.endsWith('.ndjson'))
          .map((f) => { const p = path.join(this.dir, f); const st = fs.statSync(p); return { p, size: st.size, mtime: st.mtimeMs }; })
          .filter((f) => f.p !== this.file)
          .sort((x, y) => x.mtime - y.mtime);
      } catch { /* 読めなくても、記録は続ける */ }
    }
    let total = this.known.reduce((sum, f) => sum + f.size, 0);
    while (this.known.length && total > this.maxBytes) {
      const old = this.known.shift();
      const remove = () => { try { fs.unlinkSync(old.p); } catch { /* 消せなくても、記録は続ける */ } };
      // まだ書き出しの途中のファイルは、書き終わってから消す（先に消すと、書き出しでまた作られてしまう）
      if (old.stream && !old.stream.closed) old.stream.once('close', remove);
      else remove();
      total -= old.size;
    }
  }

  write(type, data = {}) {
    if (this.level === 'off') return;
    if (this.level === 'basic' && PER_CLIENT.has(type)) return;
    const line = JSON.stringify({ type, at: nowMs(), ...data }) + '\n';
    this.stream.write(line);
    this.written += Buffer.byteLength(line);
    if (this.written >= this.fileBytes) {
      this.stream.end();
      this.known.push({ p: this.file, size: this.written, stream: this.stream }); // 書き終えたファイルを、大きさと一緒に控える
      this.part++;
      this.#open();
    }
  }

  close() {
    if (!this.stream) return Promise.resolve();
    return new Promise((resolve) => this.stream.end(resolve));
  }
}
