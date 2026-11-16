#!/usr/bin/env node
// 負荷をかけるプログラム（P2-6〜P2-9、P2-11）。
//   node tools/load.js --url ws://127.0.0.1:8080/ws --clients 100 --lots 30 --label P2-6
// 主な引数:
//   --clients 100   同時接続の数            --lots 30      くり返すロットの数
//   --burst 10      締めの直前に集中させる秒数  --rate 20      その間の毎秒の入札件数
//   --tail 1        「締め」を送った後も入札を送り続ける秒数（間に合わない入札を作る。P2-11）
//   --interval 0    ロットとロットの間隔（秒）。P2-9 は --clients 20 --lots 54 --interval 600
//   --tokens data/tokens.json   --label P2-6   --out data/load-P2-6.json
import fs from 'node:fs';
import { Client, localNow } from './client.js';

const argv = process.argv.slice(2);
const arg = (name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : d; };
const opt = {
  url: arg('url', 'ws://127.0.0.1:8080/ws'), tokens: arg('tokens', 'data/tokens.json'),
  clients: Number(arg('clients', 100)), lots: Number(arg('lots', 30)), burst: Number(arg('burst', 10)),
  rate: Number(arg('rate', 20)), tail: Number(arg('tail', 1)), idle: Number(arg('idle', 1)),
  interval: Number(arg('interval', 0)), label: arg('label', 'load'), out: arg('out', null), net: arg('net', 'load'),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 10) / 10; };

const tokens = JSON.parse(fs.readFileSync(opt.tokens, 'utf8'));
if (tokens.members.length < opt.clients) throw new Error(`テスト会員が足りません（${tokens.members.length} 人）。node tools/seed.js --members ${opt.clients} で作り直してください`);

console.log(`[load] ${opt.label}: 接続 ${opt.clients}、ロット ${opt.lots}、締め前 ${opt.burst} 秒に毎秒 ${opt.rate} 件`);
const A = new Client(opt.url, tokens.auctioneer, { label: `load-auctioneer:${opt.label}`, net: opt.net, autoReconnect: true });
await A.connect();
await A.syncClock();
const clients = [];
for (let i = 0; i < opt.clients; i += 20) {
  await Promise.all(tokens.members.slice(i, Math.min(i + 20, opt.clients)).map(async (m) => {
    const c = new Client(opt.url, m.token, { label: `load:${opt.label}`, net: opt.net, autoReconnect: true });
    await c.connect();
    await c.syncClock();
    clients.push(c);
  }));
}
const resync = setInterval(() => { for (const c of [A, ...clients]) if (!c.closed) c.syncClock().catch(() => {}); }, 30000);
console.log(`[load] ${clients.length} 接続。時刻合わせの往復 p50=${pct(clients.map((c) => c.rtt), 50)}ms`);
await A.cmd('mark', { label: opt.label, phase: 'start', data: opt });

const stats = { lots: [], closeMs: [] };
for (let n = 0; n < opt.lots; n++) {
  const created = await A.cmd('create_lot', { title: `${opt.label} 負荷 ${n + 1}`, startPrice: 1000 });
  const lotId = created.lot.id;
  const started = await A.cmd('start', { lotId });
  if (!started.ok) throw new Error(`競り開始に失敗: ${started.message}`);
  if (A.lots.get(lotId)?.status !== 'open') await A.waitFor((m) => m.type === 'lot' && m.lot.id === lotId && m.lot.status === 'open', 120000);
  await sleep(opt.idle * 1000);

  const jobs = [];
  const fire = () => {
    // 自分が最高入札者ではない端末を1つ選び、その端末が知っている最低入札額で入札する
    for (let tries = 0; tries < 5; tries++) {
      const c = clients[Math.floor(Math.random() * clients.length)];
      const lot = c.lots.get(lotId);
      if (c.closed || !lot || lot.highestPaddle === c.paddle) continue;
      jobs.push(c.bid(lotId, lot.minBid).catch(() => null));
      return;
    }
  };
  // 毎秒 rate 件。1秒の中での時刻は乱数でばらつかせる（本物の入札のように、同じ瞬間に重なるものを作るため）
  const total = Math.round((opt.burst + opt.tail) * opt.rate);
  const times = Array.from({ length: total }, (_, i) => (Math.floor(i / opt.rate) + Math.random()) * 1000).sort((a, b) => a - b);
  const t0 = localNow();
  let closeJob = null;
  let closeSentAt = null;
  for (const due of times) {
    if (!closeJob && due >= opt.burst * 1000) {
      const w = t0 + opt.burst * 1000 - localNow();
      if (w > 0) await sleep(w);
      closeSentAt = localNow();
      closeJob = A.cmd('close', { lotId }); // 進行役の「締め」
    }
    const wait = t0 + due - localNow();
    if (wait > 0) await sleep(wait);
    fire();
  }
  closeJob ??= A.cmd('close', { lotId });
  const closeRes = await closeJob;
  const results = (await Promise.all(jobs)).filter(Boolean);
  if (closeSentAt) stats.closeMs.push(closeRes.clientRecvAt - closeSentAt);
  const count = (f) => results.filter(f).length;
  const row = {
    lotId, sent: jobs.length, accepted: count((r) => r.accepted), afterClose: count((r) => r.code === 'AFTER_CLOSE'),
    belowMin: count((r) => r.code === 'BELOW_MINIMUM'), result: closeRes.status, amount: closeRes.amount,
  };
  stats.lots.push(row);
  console.log(`[load] ロット ${n + 1}/${opt.lots}: ${JSON.stringify(row)}`);
  await sleep(Math.max(500, opt.interval * 1000));
}

await sleep(1000); // 送り返し（price_ack・result_ack）が届ききるのを待つ
await A.cmd('mark', { label: opt.label, phase: 'end' });
clearInterval(resync);
const rt = clients.flatMap((c) => c.log.map((r) => r.roundTripMs));
const summary = {
  label: opt.label, options: opt, bids: rt.length,
  bidRoundTripMs: { p50: pct(rt, 50), p95: pct(rt, 95), p99: pct(rt, 99), max: pct(rt, 100) }, // 端末で測った、入札を送ってから結果が返るまで
  closeRoundTripMs: { p50: pct(stats.closeMs, 50), p95: pct(stats.closeMs, 95), max: pct(stats.closeMs, 100) },
  reconnects: clients.reduce((s, c) => s + c.reconnects, 0),
  lots: stats.lots,
};
console.log('[load] 端末側の集計:', JSON.stringify({ ...summary, lots: undefined, options: undefined }));
console.log('[load] サーバー側の記録の集計は: node tools/aggregate.js --label ' + opt.label);
if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(summary, null, 2));
for (const c of [A, ...clients]) c.close();
