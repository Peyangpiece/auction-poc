// 自動テストの共通部品: 一時ディレクトリに本物の入札サーバーを別プロセスで立て、WebSocket でつなぐ。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '../../tools/client.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function makeEnv(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auction-poc-'));
  const env = {
    ...process.env, POC_DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1',
    POC_IVS_MODE: 'always-live', POC_ALLOW_CRASH: '1', POC_SYS_SAMPLE_MS: '600000', ...extra,
  };
  execFileSync('node', ['tools/seed.js', '--members', String(extra.MEMBERS ?? 6)], { cwd: ROOT, env, stdio: 'ignore' });
  const tokens = JSON.parse(fs.readFileSync(path.join(dataDir, 'tokens.json'), 'utf8'));
  return { dataDir, env, tokens };
}

/** サーバーを起動する。同じ env で呼び直せば「再起動」になる。 */
export function startServer(ctx, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server/src/index.js'], { cwd: ROOT, env: { ...ctx.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/listening on [^:]+:(\d+)/);
      if (m) {
        const port = Number(m[1]);
        resolve({
          child, port, exited, url: `ws://127.0.0.1:${port}/ws`, agentUrl: `ws://127.0.0.1:${port}/agent`,
          httpUrl: `http://127.0.0.1:${port}`,
          async stop() { child.kill('SIGTERM'); await exited; },
          async kill9() { child.kill('SIGKILL'); await exited; },
        });
      }
    });
    child.on('error', reject);
    exited.then((e) => reject(new Error(`server exited early: ${JSON.stringify(e)}\n${out}`)));
  });
}

export async function connect(srv, token, opts = {}) {
  const c = new Client(srv.url, token, { ack: false, ...opts });
  await c.connect();
  return c;
}

export async function connectAll(srv, ctx, n) {
  const auctioneer = await connect(srv, ctx.tokens.auctioneer);
  const members = [];
  for (let i = 0; i < n; i++) members.push(await connect(srv, ctx.tokens.members[i].token));
  return { auctioneer, members };
}

export async function createLot(auctioneer, startPrice, unitOverride = null, title = 'テスト品', reservePrice = null) {
  const res = await auctioneer.cmd('create_lot', { title, startPrice, unitOverride, reservePrice });
  if (!res.ok) throw new Error(res.message);
  return res.lot;
}

export async function lotLog(auctioneer, lotId) {
  const res = await auctioneer.cmd('lot_log', { lotId });
  return res.log;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function cleanup(ctx) { fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
