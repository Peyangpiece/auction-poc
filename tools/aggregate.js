#!/usr/bin/env node
// 測定結果を集計するプログラム（PoC 仕様書 6章）。p95 などは、必ず生の記録（NDJSON）から計算する。
//   node tools/aggregate.js                      … data/metrics の全記録
//   node tools/aggregate.js --label P2-6         … 「測定開始の印」〜「測定終了の印」の間だけ
//   node tools/aggregate.js --dir data/metrics --json out.json
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : d; };
const dir = arg('dir', 'data/metrics');
const label = arg('label', null);
const jsonOut = arg('json', null);

// ---------------------------------------------------------------- 読み込み
let recs = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ndjson')).sort()) {
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!line) continue;
    try { recs.push(JSON.parse(line)); } catch { /* 強制終了で途切れた最後の行は捨てる */ }
  }
}
recs.sort((a, b) => a.at - b.at);
if (label) {
  // 同じラベルの区間が複数あれば、すべて対象にする
  const windows = [];
  let open = null;
  for (const r of recs) {
    if (r.type !== 'mark' || r.label !== label) continue;
    if (r.phase === 'start') open = r.at;
    else if (r.phase === 'end' && open !== null) { windows.push([open, r.at]); open = null; }
  }
  if (open !== null) windows.push([open, Infinity]);
  if (!windows.length) { console.error(`ラベル「${label}」の印が見つかりません`); process.exit(1); }
  recs = recs.filter((r) => windows.some(([s, e]) => r.at >= s && r.at <= e));
}
const by = (type) => recs.filter((r) => r.type === type);

// ---------------------------------------------------------------- 統計
const round = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
function dist(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const q = (p) => v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)]; // 最近順位法
  return { n: v.length, min: round(v[0]), p50: round(q(50)), p95: round(q(95)), p99: round(q(99)), max: round(v.at(-1)), mean: round(v.reduce((s, x) => s + x, 0) / v.length) };
}
const groupBy = (arr, key) => arr.reduce((m, x) => { const k = key(x); (m[k] ??= []).push(x); return m; }, {});
const judge = (value, limit) => (value === undefined || value === null ? '記録なし' : value <= limit ? '基準内' : '基準を超過');

const out = { label, from: recs[0]?.at ?? null, to: recs.at(-1)?.at ?? null, records: recs.length };

// ---------------------------------------------------------------- P2: 入札
const bids = by('bid');
const bidBySeq = new Map(bids.map((b) => [b.seq, b]));
const acks = by('price_ack').filter((a) => bidBySeq.has(a.seq));
const arrival = acks.map((a) => a.clientAt - bidBySeq.get(a.seq).receivedAt); // サーバーが入札を受け付けてから、各端末に価格の更新が届くまで
const worstPerBid = Object.values(groupBy(acks, (a) => a.seq)).map((g) => Math.max(...g.map((a) => a.clientAt - bidBySeq.get(a.seq).receivedAt)));
out.bids = {
  count: bids.length,
  results: Object.fromEntries(Object.entries(groupBy(bids, (b) => b.result)).map(([k, v]) => [k, v.length])),
  acceptResponseMs: dist(bids.map((b) => b.repliedAt - b.receivedAt)), // 受理応答（サーバーの中の処理時間）: NFR-PERF-001
  dbCommitMs: dist(bids.map((b) => b.processedAt - b.receivedAt)),
  priceArrivalMs: dist(arrival), // 価格の更新の到達（端末ごと）: NFR-PERF-002
  priceArrivalWorstDeviceMs: dist(worstPerBid), // 入札1件ごとに、最も遅かった端末
  priceArrivalByNet: Object.fromEntries(Object.entries(groupBy(acks, (a) => a.net ?? 'unlabeled')).map(([k, v]) => [k, dist(v.map((a) => a.clientAt - bidBySeq.get(a.seq).receivedAt))])),
  uplinkMs: dist(bids.filter((b) => b.clientSentAtCorrected).map((b) => b.receivedAt - b.clientSentAtCorrected)), // 端末が送ってからサーバーが受け付けるまで
};
out.bids.judge = {
  'NFR-PERF-001 受理応答 p95 ≤ 200ms': judge(out.bids.acceptResponseMs.p95, 200),
  'NFR-PERF-002 価格更新の到達 p95 ≤ 1000ms': judge(out.bids.priceArrivalMs.p95, 1000),
};

// ---------------------------------------------------------------- P2-10・P2-11: 締め
const closes = by('close').filter((c) => !c.recovered);
const closeByLot = new Map(closes.map((c) => [c.lotId, c]));
const racks = by('result_ack').filter((a) => closeByLot.has(a.lotId));
const lagFromServer = (a) => a.clientAt - closeByLot.get(a.lotId).receivedAt;
const lagFromPress = (a) => { const c = closeByLot.get(a.lotId); return c.clientSentAtCorrected ? a.clientAt - c.clientSentAtCorrected : null; };
const late = bids.filter((b) => {
  const c = closeByLot.get(b.lotId);
  return c && b.result === 'AFTER_CLOSE' && b.clientSentAtCorrected && b.clientSentAtCorrected <= c.receivedAt && b.clientSentAtCorrected >= c.receivedAt - 1000;
});
out.close = {
  count: closes.length,
  finalizeMs: dist(closes.map((c) => c.broadcastAt - c.receivedAt)), // 「締め」を受け付けてから、確定して送り出すまで（サーバーの中）
  pressToResultMs: dist(racks.map(lagFromPress)), // 進行役が押してから、各端末に結果が出るまで（P2-10）
  pressToResultByNet: Object.fromEntries(Object.entries(groupBy(racks, (a) => a.net ?? 'unlabeled')).map(([k, v]) => [k, dist(v.map(lagFromPress))])),
  serverToResultMs: dist(racks.map(lagFromServer)),
  afterCloseTotal: bids.filter((b) => b.result === 'AFTER_CLOSE').length,
  // P2-11: 締めの前1秒以内に端末が送ったのに、AFTER_CLOSE になった入札
  sentBeforeCloseButLate: { count: late.length, sendToRejectMs: dist(late.map((b) => b.repliedAt - b.clientSentAtCorrected)), sentBeforeCloseMs: dist(late.map((b) => closeByLot.get(b.lotId).receivedAt - b.clientSentAtCorrected)) },
};
out.close.judge = { 'P2-10 締めの操作から結果の表示まで p95 ≤ 1000ms': judge(out.close.pressToResultMs.p95, 1000) };

// ---------------------------------------------------------------- P1: 配信の自動制御
const agentCmds = by('agent_cmd');
const ivs = by('ivs_state');
const after = (arr, t, pred = (_r) => true) => arr.find((r) => r.at >= t && pred(r));
out.streamStarts = by('stream_wait_start').map((w) => {
  const cmd = after(agentCmds, w.startedAt - 5, (c) => c.action === 'start');
  const livePoll = after(ivs, w.startedAt, (r) => r.method === 'poll' && r.live);
  const liveEvent = after(ivs, w.startedAt, (r) => r.method === 'event' && r.live);
  const liveMock = after(ivs, w.startedAt, (r) => r.method === 'mock' && r.live);
  const ready = after(by('stream_ready'), w.startedAt);
  const timeout = after(by('stream_wait_timeout'), w.startedAt);
  const d = (t) => (t ? round(t - w.startedAt) : null);
  return {
    startedAt: new Date(w.startedAt).toISOString(), lotId: w.lotId ?? null, agentOk: cmd?.ok ?? null, agentError: cmd?.error ?? null,
    toObsCommandMs: d(cmd?.agent?.obsSentAt), toObsStreamingMs: d(cmd?.agent?.obsStateAt),
    toLivePollMs: d(livePoll?.at), toLiveEventMs: d(liveEvent?.at), toLiveMockMs: d(liveMock?.at),
    toOpenMs: d(ready?.readyAt), warned: !!(timeout && (!ready || timeout.at < ready.at)),
  };
});
const firstLive = out.streamStarts.map((s) => Math.min(...[s.toLivePollMs, s.toLiveEventMs, s.toLiveMockMs].filter((x) => x !== null))).filter(Number.isFinite);
out.streamStartSummary = {
  count: out.streamStarts.length, toObsStreamingMs: dist(out.streamStarts.map((s) => s.toObsStreamingMs)),
  toLivePollMs: dist(out.streamStarts.map((s) => s.toLivePollMs)), toLiveEventMs: dist(out.streamStarts.map((s) => s.toLiveEventMs)),
  toFirstLiveMs: dist(firstLive), toOpenMs: dist(out.streamStarts.map((s) => s.toOpenMs)),
  judge: { 'P1-1 すべての回で 60秒以内に LIVE': out.streamStarts.length ? (firstLive.length === out.streamStarts.length && Math.max(...firstLive) <= 60000 ? '基準内' : '基準を超過') : '記録なし' },
};
out.autoStops = by('auto_stop').map((a) => {
  const cmd = after(agentCmds, a.firedAt - 5, (c) => c.action === 'stop');
  const offPoll = after(ivs, a.firedAt, (r) => r.method === 'poll' && !r.live);
  const offEvent = after(ivs, a.firedAt, (r) => r.method === 'event' && !r.live);
  return {
    armedAt: new Date(a.armedAt).toISOString(), settingMs: a.autoStopMs, firedAfterMs: round(a.firedAt - a.armedAt),
    obsStoppedAfterMs: cmd?.agent?.obsStateAt ? round(cmd.agent.obsStateAt - a.armedAt) : null, agentOk: cmd?.ok ?? null,
    ivsOfflinePollAfterMs: offPoll ? round(offPoll.at - a.armedAt) : null, ivsOfflineEventAfterMs: offEvent ? round(offEvent.at - a.armedAt) : null,
  };
});
out.autoStopSummary = {
  count: out.autoStops.length,
  overshootMs: dist(out.autoStops.map((s) => (s.obsStoppedAfterMs ?? NaN) - s.settingMs)), // 設定した待ち時間から、OBS が止まるまでの超過
  judge: { 'P1-2 すべての回で、待ち時間から10秒以内に停止': out.autoStops.length ? (out.autoStops.every((s) => s.obsStoppedAfterMs !== null && s.obsStoppedAfterMs - s.settingMs <= 10000) ? '基準内' : '基準を超過') : '記録なし' },
};
out.agent = { connects: by('agent_connected').length, disconnects: by('agent_disconnected').length, obsStateChanges: by('obs_state').length, ivsEvents: by('ivs_event').length, ivsPollErrors: by('ivs_poll_error').length };

// ---------------------------------------------------------------- P3: 実機
const ce = (name) => by('client_event').filter((e) => e.name === name);
const lat = by('video_latency');
out.devices = ce('device').map((e) => ({ paddle: e.paddle, ...e.data }));
out.videoLatencyMsByNet = Object.fromEntries(Object.entries(groupBy(lat, (l) => l.net ?? 'unlabeled')).map(([k, v]) => [k, dist(v.map((l) => l.latencyMs))])); // P3-4
out.bidButtonToResultMsByNet = Object.fromEntries(Object.entries(groupBy(ce('bid_rtt'), (e) => e.data?.net ?? 'unlabeled')).map(([k, v]) => [k, dist(v.map((e) => e.data.ms))])); // P3-7
out.reconnects = ce('reconnect').map((e) => ({ paddle: e.paddle, ...e.data })); // P3-5
out.outbidNotifies = ce('outbid_notify').map((e) => ({ paddle: e.paddle, ...e.data })); // P3-1・P3-2
out.playerErrors = ce('player_error').length;

// ---------------------------------------------------------------- CPU・メモリ（P2-8、P2-9）
const sys = by('sys');
if (sys.length >= 2) {
  const mb = (x) => round(x / 1048576);
  // メモリが増え続けていないか: 最小二乗法の傾き（MB／時）と、前半・後半の平均の比較
  const t0 = sys[0].at;
  const xs = sys.map((s) => (s.at - t0) / 3600000), ys = sys.map((s) => s.rss / 1048576);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / (xs.reduce((s, x) => s + (x - mx) ** 2, 0) || 1);
  const half = Math.floor(sys.length / 2);
  const avg = (a) => a.reduce((s, x) => s + x.rss, 0) / a.length;
  out.sys = {
    samples: sys.length, hours: round(xs.at(-1)), rssMb: { first: mb(sys[0].rss), last: mb(sys.at(-1).rss), min: mb(Math.min(...sys.map((s) => s.rss))), max: mb(Math.max(...sys.map((s) => s.rss))) },
    rssSlopeMbPerHour: round(slope), rssFirstHalfMb: mb(avg(sys.slice(0, half))), rssSecondHalfMb: mb(avg(sys.slice(half))),
    cpuPct: dist(sys.map((s) => s.cpuPct)), connections: dist(sys.map((s) => s.connections)),
  };
}
out.serverStarts = by('server_start').length;
out.recoveries = by('recovery').filter((r) => r.report?.length).map((r) => r.report);

// ---------------------------------------------------------------- 出力
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2));
const line = (name, d, unit = 'ms') => (d?.n ? `${name}: n=${d.n} p50=${d.p50} p95=${d.p95} p99=${d.p99} max=${d.max} mean=${d.mean} ${unit}` : `${name}: 記録なし`);
const show = (title, rows) => console.log(`\n■ ${title}\n` + rows.filter(Boolean).map((r) => '  ' + r).join('\n'));
const iso = (t) => (t ? new Date(t).toISOString() : '—');
console.log(`集計の対象: ${label ? `ラベル「${label}」` : 'すべての記録'}　${iso(out.from)} 〜 ${iso(out.to)}（UTC）　${out.records} 件`);
show('入札（P2-6〜8）', [
  `件数 ${out.bids.count}　内訳 ${JSON.stringify(out.bids.results)}`,
  line('受理応答（サーバーの中の処理時間）', out.bids.acceptResponseMs),
  line('  うち DB への書き込みまで', out.bids.dbCommitMs),
  line('価格更新の到達（端末ごと）', out.bids.priceArrivalMs),
  line('価格更新の到達（入札ごとの最も遅い端末）', out.bids.priceArrivalWorstDeviceMs),
  ...Object.entries(out.bids.priceArrivalByNet).map(([k, d]) => line(`  回線 ${k}`, d)),
  line('端末が送ってから受付まで', out.bids.uplinkMs),
  ...Object.entries(out.bids.judge).map(([k, v]) => `判定の目安: ${k} → ${v}`),
]);
show('締め（P2-10・P2-11）', [
  `締めの回数 ${out.close.count}`,
  line('締めの受付から確定の送り出しまで（サーバーの中）', out.close.finalizeMs),
  line('進行役が押してから各端末に結果が出るまで', out.close.pressToResultMs),
  ...Object.entries(out.close.pressToResultByNet).map(([k, d]) => line(`  回線 ${k}`, d)),
  `AFTER_CLOSE の合計 ${out.close.afterCloseTotal} 件。うち、締めの前1秒以内に端末が送っていたもの ${out.close.sentBeforeCloseButLate.count} 件`,
  line('  その入札の、送信から拒否まで', out.close.sentBeforeCloseButLate.sendToRejectMs),
  ...Object.entries(out.close.judge).map(([k, v]) => `判定の目安: ${k} → ${v}`),
]);
show('配信の自動開始（P1-1・P1-5）', [
  `回数 ${out.streamStartSummary.count}`,
  line('「競り開始」から OBS の配信開始まで', out.streamStartSummary.toObsStreamingMs),
  line('「競り開始」から LIVE と判断するまで (a) 問い合わせ', out.streamStartSummary.toLivePollMs),
  line('「競り開始」から LIVE と判断するまで (b) イベント', out.streamStartSummary.toLiveEventMs),
  line('「競り開始」から受付中になるまで', out.streamStartSummary.toOpenMs),
  ...Object.entries(out.streamStartSummary.judge).map(([k, v]) => `判定の目安: ${k} → ${v}`),
  ...out.streamStarts.map((s, i) => `#${i + 1} ${JSON.stringify(s)}`),
]);
show('配信の自動停止（P1-2）', [
  `回数 ${out.autoStopSummary.count}`,
  line('設定した待ち時間から OBS の停止までの超過', out.autoStopSummary.overshootMs),
  ...Object.entries(out.autoStopSummary.judge).map(([k, v]) => `判定の目安: ${k} → ${v}`),
  ...out.autoStops.map((s, i) => `#${i + 1} ${JSON.stringify(s)}`),
  `エージェント: ${JSON.stringify(out.agent)}`,
]);
show('実機（P3）', [
  ...out.devices.map((d) => `端末: ${JSON.stringify(d)}`),
  ...Object.entries(out.videoLatencyMsByNet).map(([k, d]) => line(`映像の遅延 回線 ${k}`, d)),
  ...Object.entries(out.bidButtonToResultMsByNet).map(([k, d]) => line(`入札ボタンから結果の表示まで 回線 ${k}`, d)),
  `再接続 ${out.reconnects.length} 回 ${JSON.stringify(out.reconnects)}`,
  `上回られた通知 ${out.outbidNotifies.length} 回 ${JSON.stringify(out.outbidNotifies.slice(0, 20))}`,
  `プレーヤーのエラー ${out.playerErrors} 件`,
]);
if (out.sys) {
  show('CPU・メモリ（P2-8・P2-9）', [
    `${out.sys.hours} 時間、${out.sys.samples} 回の記録`,
    `メモリ（RSS）MB: ${JSON.stringify(out.sys.rssMb)}　傾き ${out.sys.rssSlopeMbPerHour} MB/時　前半の平均 ${out.sys.rssFirstHalfMb} → 後半の平均 ${out.sys.rssSecondHalfMb}`,
    line('CPU（1コアを100とする）', out.sys.cpuPct, '%'),
    line('接続数', out.sys.connections, ''),
  ]);
}
console.log(`\nサーバーの起動 ${out.serverStarts} 回、復旧で状態を直したロット ${JSON.stringify(out.recoveries)}`);
console.log('※ 「判定の目安」は機械的な比較です。合否は、測定の条件（サーバー・回線・端末）を確かめたうえで報告書に書いてください。');
