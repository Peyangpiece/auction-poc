// スマートフォンの横向き: 下に固定した入札の帯が、受付中の印・番号・価格・ランプを隠さないこと（報告書 120 章）
import { boot, chromium, check } from './lib.mjs';
const OUT = process.argv[2] ?? null; // 画面の写しを残す場所（省けば残さない）
const sys = await boot({ port: 8297, env: { POC_IVS_MODE: 'always-live' }, members: 3 });
const browser = await chromium.launch();
const open = async (url, opts) => { const p = await (await browser.newContext(opts)).newPage(); await p.goto(url); return p; };
try {
  const con = await open(`${sys.base}/console.html?t=${sys.tokens.auctioneer}`, { viewport: { width: 1200, height: 900 } });
  const sizes = [[844, 390], [667, 375], [932, 430], [568, 320]];
  const pages = [];
  for (const [i, [w, h]] of sizes.entries()) { const b = await open(`${sys.base}/bidder.html?t=${sys.tokens.members[i % 3].token}`, { viewport: { width: w, height: h }, hasTouch: true, isMobile: true }); await b.click('#enter'); await b.waitForFunction(() => document.getElementById('me').textContent.includes('番')); pages.push([b, w, h]); }
  await con.fill('#newTitle', '古い柱時計（振り子つき・動作品）'); await con.fill('#newPrice', '9500'); await con.click('#create');
  await con.waitForSelector('#b_next:not([hidden])'); await con.click('#b_next');
  await con.waitForFunction(() => document.getElementById('status').textContent.includes('受付中'), null, { timeout: 15000 });
  for (const [b, w, h] of pages) {
    await b.waitForFunction(() => document.getElementById('bid').dataset.ready === '1');
    await b.waitForTimeout(400);
    if (OUT) await b.screenshot({ path: `${OUT}/open-${w}x${h}.png` });
    const r = await b.evaluate(() => {
      const box = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return { s, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), vis: c.display !== 'none' && c.visibility !== 'hidden' && r.width > 0 }; };
      // 入札の帯（下に固定された部分）が、ほかの大事な表示に重なっていないか
      const covered = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); if (!r.width) return 'hidden'; const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return top === e || e.contains(top) || top?.contains(e) ? 'ok' : `covered by ${top?.id || top?.className}`; };
      return { vh: innerHeight, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, items: ['#status', '#boardNo', '#price', '.lamps', '#bidAmount', '#bid', '#video', '.lotname'].map((s) => ({ ...box(s), cov: covered(s) })) };
    });
    const bad = r.items.filter((i) => i.cov !== 'ok' && i.cov !== 'hidden' || i.vis && i.bottom > r.vh);
    check(bad.length === 0, `横向き ${w}×${h}: 受付中の印・価格・ランプ・入札の欄が、隠れずに1画面に収まる${bad.length ? '（' + JSON.stringify(bad) + '）' : ''}`);
    check(r.sw <= w, `横向き ${w}×${h}: 横にあふれない`);
  }
  console.log('\nすべて確認しました');
} finally { await browser.close(); sys.stop(); }
