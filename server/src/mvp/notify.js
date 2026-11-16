// SMS とメールの送信（本仕様 IF-EXT-003: 失敗したら3回まで再送し、それでも失敗したら主催者管理者に知らせる）。
//
// 送信サービスはまだ選ばれていない（本仕様 6章の依存）。そのため、送る部分を差し替えられる形にしてある。
// いま入っているのは開発用の「書き出し」だけで、実際には送らず、data/outbox にファイルとして残す。
// 本番では、選んだサービス用の送り手を足して、設定で切り替える。
import fs from 'node:fs';
import path from 'node:path';

/** 開発用: 送らずに、1通1行でファイルに残す。認証番号を画面やログに出さずに、手元で確かめるためのもの */
export function outboxSender(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'outbox.ndjson');
  return async (message) => {
    fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ...message }) + '\n', { mode: 0o600 });
  };
}

export class Notifier {
  /**
   * @param {(message: object) => Promise<void>} send 1通を送る関数（失敗したら例外を投げる）
   * @param {(failure: object) => void} onGiveUp 再送しても失敗したときに呼ぶ（主催者管理者への知らせに使う）
   */
  constructor(send, onGiveUp = () => {}, { retries = 3, waitMs = 500 } = {}) {
    this.send = send;
    this.onGiveUp = onGiveUp;
    this.retries = retries;
    this.waitMs = waitMs;
  }

  async #deliver(message) {
    let lastError = null;
    // 最初の1回と、再送3回
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        await this.send(message);
        return true;
      } catch (err) {
        lastError = err;
      }
      if (attempt < this.retries) await new Promise((r) => setTimeout(r, this.waitMs * (attempt + 1)));
    }
    this.onGiveUp({ channel: message.channel, to: message.to, kind: message.kind, error: String(lastError?.message ?? lastError) });
    return false;
  }

  sms(to, kind, body) {
    return this.#deliver({ channel: 'sms', to, kind, body });
  }

  email(to, kind, subject, body) {
    return this.#deliver({ channel: 'email', to, kind, subject, body });
  }
}
