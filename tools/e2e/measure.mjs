#!/usr/bin/env node
// 画面の実測: 端末の幅ごとに、横あふれ・押せる範囲・文字の大きさ・固定の板が映像を隠していないかを測る。
// 基準に外れたら失敗（終了コード 1）にする。
//   node tools/e2e/measure.mjs
import { boot, chromium, check } from './lib.mjs';

const sys = await boot({ port: 8290, env: { POC_IVS_MODE: 'always-live' } });
const browser = await chromium.launch();
const audit = () => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !el.closest('[hidden]') && !el.closest('details:not([open]) > :not(summary)'); };
  const name = (el) => (el.id ? '#' + el.id : el.tagName.toLowerCase()) + ' "' + (el.textContent || '').trim().slice(0, 12) + '"';
  const targets = [...document.querySelectorAll('button, a[href], input, select, textarea, summary')].filter(vis)
    .map((el) => { const t = el.matches('input[type=checkbox]') && el.closest('label') ? el.closest('label') : el; const r = t.getBoundingClientRect(); return { n: name(el), w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter((t) => t.w < 44 || t.h < 44);
  const small = [...document.querySelectorAll('body *')].filter((el) => vis(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
    .map((el) => ({ n: name(el), px: parseFloat(getComputedStyle(el).fontSize) })).filter((x) => x.px < 12);
  const board = document.querySelector('.board');
  const fixed = board && getComputedStyle(board).position === 'fixed';
  const bh = board ? board.getBoundingClientRect().height : 0;
  const v = document.getElementById('videoBox');
  const vr = v && v.getBoundingClientRect();
  return {
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    smallTargets: targets, smallText: small,
    videoHiddenPx: fixed && vr && vr.height ? Math.max(0, Math.round(vr.bottom - (innerHeight - bh))) : 0,
    videoRatio: vr && vr.height ? +(vr.width / vr.height).toFixed(3) : null,
  };
};
// 進行コンソールは PC・タブレット用。押せる範囲の基準は、指で押すスマホ幅の入札画面にだけ当てる
const judge = (label, r, { touch }) => {
  check(r.overflowX === 0, `${label}: 横あふれなし`);
  check(r.smallText.length === 0, `${label}: 12px 未満の文字なし ${JSON.stringify(r.smallText)}`);
  if (touch) check(r.smallTargets.length === 0, `${label}: 44px 未満の押せる範囲なし ${JSON.stringify(r.smallTargets)}`);
  check(r.videoHiddenPx === 0, `${label}: 固定の板が映像を隠していない`);
  if (r.videoRatio !== null) check(r.videoRatio === 1.333, `${label}: ライブ画面は 4:3`);
};
try {
  const con = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await con.goto(`${sys.base}/console.html?t=${sys.tokens.auctioneer}`);
  await con.fill('#newTitle', 'テスト品'); await con.fill('#newPrice', '9500');
  await con.click('#create'); await con.click('#b_next');
  await con.waitForFunction(() => document.getElementById('status').textContent.includes('受付中'));
  for (const [w, h] of [[320, 568], [360, 740], [390, 664], [640, 450], [740, 360], [1280, 800]]) {
    const p = await (await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 800 })).newPage();
    await p.goto(`${sys.base}/bidder.html?t=${sys.tokens.members[0].token}`);
    await p.click('#enter'); // 低い画面でも「参加する」に届くこと自体が、確認の1つ
    await p.waitForTimeout(500);
    judge(`入札画面 ${w}×${h}`, await p.evaluate(audit), { touch: w < 800 });
    await p.context().close();
  }
  judge('進行コンソール 1280×900', await con.evaluate(audit), { touch: false });
  const tab = await (await browser.newContext({ viewport: { width: 768, height: 1024 } })).newPage();
  await tab.goto(`${sys.base}/console.html?t=${sys.tokens.auctioneer}`); await tab.waitForTimeout(500);
  judge('進行コンソール 768×1024', await tab.evaluate(audit), { touch: false });
  console.log('\n実測: すべて基準内');
} catch (err) {
  console.error('\n' + err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  sys.stop();
}
