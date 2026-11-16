// 画面の自動確認の共通部品: 一時フォルダに、入札サーバー・OBS の代役・配信エージェントを立てる。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
// Playwright は、このリポジトリには入れていない（環境に入っているもの、または CI で入れたものを使う）
export const { chromium, devices } = require('playwright');

export async function boot({ port, env = {}, members = 3, withAgent = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auction-e2e-'));
  const full = { ...process.env, POC_DATA_DIR: path.join(dir, 'data'), PORT: String(port), HOST: '127.0.0.1', POC_ALLOW_CRASH: '1', ...env };
  execFileSync('node', ['tools/seed.js', '--members', String(members)], { cwd: ROOT, env: full, stdio: 'ignore' });
  const tokens = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'tokens.json'), 'utf8'));
  const procs = [];
  const startServer = () => { const p = spawn('node', ['server/src/index.js'], { cwd: ROOT, env: full, stdio: 'ignore' }); procs.push(p); return p; };
  let server = startServer();
  if (withAgent) {
    const obsPort = port + 1000;
    procs.push(spawn('node', ['tools/mock-obs.js', '--port', String(obsPort)], { cwd: ROOT, stdio: 'ignore' }));
    await new Promise((r) => setTimeout(r, 700));
    procs.push(spawn('node', ['src/agent.js'], { cwd: path.join(ROOT, 'agent'), stdio: 'ignore',
      env: { ...process.env, AGENT_SERVER_URL: `ws://127.0.0.1:${port}/agent`, AGENT_TOKEN: tokens.agent, OBS_URL: `ws://127.0.0.1:${obsPort}`, AGENT_LOG_DIR: path.join(dir, 'agent-logs') } }));
  }
  await new Promise((r) => setTimeout(r, 900));
  return {
    dir, tokens, base: `http://127.0.0.1:${port}`,
    get server() { return server; },
    restartServer() { server = startServer(); },
    stop() { for (const p of procs) { try { p.kill('SIGCONT'); p.kill('SIGKILL'); } catch {} } fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

export function check(cond, message) {
  if (!cond) throw new Error('確認に失敗: ' + message);
  console.log('  ok  ' + message);
}
