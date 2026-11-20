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

/**
 * 本番用: メールを、取り次ぎ先（Cloudflare の Worker → 送信サービス）へ送る。
 * メール以外（請求メールの下書き・SMS）は、other に任せる。
 * 送ったメールの本文（認証番号やパスワードを含む）は、ファイルに残さない。
 */
export function httpMailSender(url, other) {
  return async (message) => {
    if (message.channel !== 'email') return other(message);
    const res = await fetch(url + '/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: message.to, subject: message.subject, text: message.body }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      let why = '';
      try { why = (await res.json()).error ?? ''; } catch { /* 理由なし */ }
      const err = new Error(`メールを送れませんでした（${res.status}）${why ? ' ' + why : ''}`);
      // 宛先や中身がおかしいと言われたとき（400 番台。混雑の 429 と時間切れの 408 は除く）は、送り直しても同じなので、やり直さない
      err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408;
      throw err;
    }
    await res.body?.cancel();
  };
}

export class Notifier {
  /**
   * @param {(message: object) => Promise<void>} send 1通を送る関数（失敗したら例外を投げる）
   * @param {(failure: object) => void} onGiveUp 再送しても失敗したときに呼ぶ（主催者管理者への知らせに使う）
   */
  constructor(send, onGiveUp = () => {}, { retries = 3, waitMs = 500, intervalMs = 0 } = {}) {
    this.send = send;
    this.onGiveUp = onGiveUp;
    this.retries = retries;
    this.waitMs = waitMs;
    // メールは、1通ずつ、決まった間隔をあけて送る（送信サービスの速さの上限に当たって、一斉に送ったお知らせが落ちないように。本番運用の評価 B11）
    this.intervalMs = intervalMs;
    // 待ちの列は2本。急ぎ（認証番号）は、ふつうのメール（お知らせ・請求）より先に送る。
    // 1本だけだと、大量のお知らせや、いたずらの登録が、認証番号を何分も待たせてしまう
    this.urgent = []; this.normal = []; this.pumping = false;
  }

  async #pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const job = this.urgent.shift() ?? this.normal.shift();
        if (!job) break;
        job.resolve(await this.#deliver(job.message));
        await new Promise((r) => setTimeout(r, this.intervalMs));
      }
    } finally { this.pumping = false; }
  }
  /** まだ送っていないメールの数（急ぎ・ふつう） */
  get waiting() { return { urgent: this.urgent.length, normal: this.normal.length }; }

  async #deliver(message) {
    let lastError = null;
    // 最初の1回と、再送3回
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        await this.send(message);
        return true;
      } catch (err) {
        lastError = err;
        if (err?.permanent) break;
      }
      if (attempt < this.retries) await new Promise((r) => setTimeout(r, this.waitMs * (attempt + 1)));
    }
    this.onGiveUp({ channel: message.channel, to: message.to, kind: message.kind, error: String(lastError?.message ?? lastError) });
    return false;
  }

  sms(to, kind, body) {
    return this.#deliver({ channel: 'sms', to, kind, body });
  }

  /**
   * 請求メールの下書きを作る（FR-INV-007）。送信はしない（利用会社の担当者が、自分で送る）。
   * 本番では、利用会社の Outlook の「下書き」に保存する送り手に差し替える（FR-INV-009）。いまは、開発用の書き出しに残すだけ。
   */
  draft(to, subject, body, attachments = []) {
    return this.#deliver({ channel: 'draft', to, kind: 'invoice', subject, body, attachments });
  }

  email(to, kind, subject, body) {
    if (!this.intervalMs) return this.#deliver({ channel: 'email', to, kind, subject, body });
    return new Promise((resolve) => {
      (kind === 'otp' ? this.urgent : this.normal).push({ message: { channel: 'email', to, kind, subject, body }, resolve });
      this.#pump();
    });
  }
}
