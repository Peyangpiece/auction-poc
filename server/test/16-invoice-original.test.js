// 請求書の発行者の情報と印鑑を、原本の値で固定する（発注者の指示。報告書 72 章）。
// 値は、配るときに、データの保存先の brand/original.json に置かれる。ここでは架空の値で確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { createApi } from '../src/mvp/api.js';
import { totp } from '../src/mvp/security.js';

// 1×1 の PNG（架空の印鑑の代わり）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const ORIGINAL = {
  org_name: '株式会社テスト', org_address: '〒100-0001\n東京都千代田区架空\n1-2-3', org_tel: '000-0000-0000', org_email: 'billing@example.com',
  invoice_reg_no: 'T0000000000000', bank_account: '架空銀行　本店（001）株式会社テスト　0000000',
};

async function start(original) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auction-orig-'));
  if (original) { fs.mkdirSync(path.join(dataDir, 'brand'), { recursive: true }); fs.writeFileSync(path.join(dataDir, 'brand', 'original.json'), JSON.stringify(original)); fs.writeFileSync(path.join(dataDir, 'brand', 'original-seal.png'), PNG); }
  const config = loadConfig({ POC_DATA_DIR: dataDir, POC_AUTH_RATE: '0' });
  const store = openDb(config.dbPath);
  const api = createApi({ store, config, nowMs: () => Date.now() });
  const server = http.createServer((req, res) => api.handle(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* 画像 */ }
    return { status: res.status, json, buf };
  };
  const s = api.createStaff({ loginId: 'kanri', name: '管理', role: 'admin' });
  assert.equal((await call('POST', '/api/staff/login', { loginId: 'kanri', password: s.initialPassword, code: totp(s.totpSecret) })).status, 200);
  return { dataDir, call, close: async () => { await new Promise((r) => server.close(r)); await api.billing.filesIdle(); store.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test('原本の値があれば、起動のときに設定と印鑑に入れ、画面からは変えられない', async () => {
  const t = await start(ORIGINAL);
  try {
    const s = (await t.call('GET', '/api/settings')).json;
    assert.deepEqual([s.orgName, s.orgAddress, s.orgTel, s.orgEmail, s.invoiceRegNo, s.bankAccount], [ORIGINAL.org_name, ORIGINAL.org_address, ORIGINAL.org_tel, ORIGINAL.org_email, ORIGINAL.invoice_reg_no, ORIGINAL.bank_account]);
    assert.deepEqual(s.fixed.sort(), ['bankAccount', 'invoiceRegNo', 'orgAddress', 'orgEmail', 'orgName', 'orgTel'], '原本で固定している項目を、画面に知らせる');
    assert.equal(s.sealFixed, true);
    const seal = await t.call('GET', '/api/settings/seal');
    assert.ok(seal.buf.equals(PNG), '印鑑は、原本の画像');
    // 画面から変えようとしても、原本の値のまま。ほかの項目は変えられる
    assert.equal((await t.call('POST', '/api/settings', { ...s, orgName: '別の会社', orgTel: '111', returnPolicy: '返品は受けません', shippingNotice: '送料は別' })).status, 200);
    const after = (await t.call('GET', '/api/settings')).json;
    assert.deepEqual([after.orgName, after.orgTel, after.returnPolicy], [ORIGINAL.org_name, ORIGINAL.org_tel, '返品は受けません']);
    assert.equal((await t.call('POST', '/api/settings/seal', { image: null })).status, 409, '印鑑も、画面からは消せない');
  } finally { await t.close(); }
});

test('原本の値がなければ、これまでどおり画面で変えられる', async () => {
  const t = await start(null);
  try {
    const s = (await t.call('GET', '/api/settings')).json;
    assert.deepEqual([s.fixed, s.sealFixed], [[], false]);
    await t.call('POST', '/api/settings', { ...s, orgTel: '03-0000-0000' });
    assert.equal((await t.call('GET', '/api/settings')).json.orgTel, '03-0000-0000');
    assert.equal((await t.call('POST', '/api/settings/seal', { image: PNG.toString('base64') })).status, 200);
  } finally { await t.close(); }
});
