// 請求書の PDF: 読み上げソフト用の構造（タグ）が付いていること。報告書 120 章
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeInvoiceFiles } from '../src/mvp/invoice-files.js';

test('請求書の PDF に、読み上げ用の構造・言語（日本語）・題名が入る。2ページ以上でも作れる', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auction-pdf-'));
  try {
    for (const n of [2, 45]) {
      const lines = Array.from({ length: n }, (_, i) => ({ label: `No.${i + 1} （例）ランタン`, amount: 1000 + i, premium: 100, kind: 'lot', receive: 'pickup' }));
      const f = makeInvoiceFiles({ dir, invoice: { number: `T-${n}`, kind: 'transfer', total: 5000, due_date: '2026-12-12', issued_at: Date.parse('2026-12-07T03:00:00Z') }, lines,
        org: { org_name: '（例）検証の会社', org_address: '（例）住所', org_tel: '', org_email: '', invoice_reg_no: '', bank_account: '（例）口座' }, to: { name: '検証 太郎', address: '（例）住所' }, issuedOn: '2026-12-07', subject: '12.7 令和の競り', premium: { total: 100 * n, rate: 10 } });
      await f.done;
      const pdf = fs.readFileSync(f.pdf).toString('latin1');
      assert.match(pdf, /\/StructTreeRoot/, '構造の木がある');
      assert.match(pdf, /\/Marked true/, 'タグ付きの印がある');
      assert.match(pdf, /\/Lang \(ja-JP\)/, '言語は日本語');
      assert.match(pdf, /\/DisplayDocTitle true/, '窓の題に、題名を出す');
      assert.ok(fs.statSync(f.xlsx).size > 1000);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
