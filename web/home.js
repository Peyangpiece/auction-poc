// トップページ: 開催の当日は、開催の案内と「参加する」を大きく出す。その下に、次の開催の一覧。
'use strict';

const hm = (t) => t.slice(11).replace(/^0/, '');           // 09:00 → 9:00
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
let schedule = { today: '', events: [] };

function showToday(e) {
  $('#todayTitle').textContent = e.title;
  $('#todayTime').textContent = `${hm(e.startsAt)} 〜 ${hm(e.endsAt)}`;
  $('#todayVenue').textContent = `${e.venueName}（${e.venueAddress}）`;
  const items = e.highlights.split('\n').map((x) => x.trim()).filter(Boolean);
  $('#todayList').replaceChildren(...items.map((text) => el('li', { text })));
  $('#todayItems').hidden = items.length === 0;
  $('#today').hidden = false;
}

// 次の開催の一覧（月の表は使わない: 開催は月に2〜3回なので、表のほとんどが空になる）。
// 日付は、カレンダーのアプリと同じ形の札（月・日・曜日）。今日の開催は、上の「本日開催」に出しているので、ここには出さない
function drawUpcoming() {
  const list = schedule.events.filter((e) => e.startsAt.slice(0, 10) > schedule.today).slice(0, 6);
  if (!list.length) {
    $('#nextList').replaceChildren(el('li', { class: 'nextlist__empty' },
      el('span', { class: 'nextlist__icon', 'aria-hidden': 'true' }),
      el('b', { text: '次の開催は、まだ決まっていません' }),
      el('span', { text: '決まりしだい、ここに出します。前日には、メールでもお知らせします。' })));
    return;
  }
  $('#nextList').replaceChildren(...list.map((e) => {
    const [yy, mm, dd] = e.startsAt.slice(0, 10).split('-').map(Number);
    const w = WEEK[new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay()];
    return el('li', {},
      el('span', { class: 'datechip', 'aria-label': `${mm}月${dd}日（${w}）` },
        el('small', { text: `${mm}月` }), el('b', { class: 'digits', text: String(dd) }), el('small', { text: w })),
      el('span', { class: 'nextlist__main' },
        el('b', { text: e.title }),
        el('span', { class: 'digits', text: `${hm(e.startsAt)} 〜 ${hm(e.endsAt)}　${e.venueName}` })));
  }));
}

(async () => {
  const [me, res, terms] = await Promise.all([setupNav(), api('GET', '/api/schedule'), api('GET', '/api/terms')]);
  if (res.ok) {
    schedule = res;
    if (res.todayEvent) showToday(res.todayEvent);
  } else {
    // 予定を取れなかったときも、端末の時計の今日で、一覧は出す（空の知らせになる）
    schedule.today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
  }
  drawUpcoming();
  $('#lead').hidden = !!(me.member || me.staff);
  // 会員には、いちばん最近に終わった開催で、何をいくらで落札したかの一覧を出す
  if (me.member) showWins(await api('GET', '/api/my/wins'));
  if (terms.ok) {
    // 落札額のほかにかかる費用は、入札の前に分かるように出す
    if (terms.premiumRate > 0) { $('#premium').textContent = `落札額のほかに、買歩銭（落札額の${terms.premiumRate}%）がかかります。`; $('#premiumBox').hidden = false; }
    $('#shipping').textContent = terms.shippingNotice;
    $('#returns').textContent = terms.returnPolicy;
    $('#terms').hidden = false;
  }
})();

// ---- 落札の結果（開催が終わったあと）
function showWins(res) {
  if (!res.ok || !res.event || !res.lines.length) return;
  const [, mo, d] = res.event.date.split('-').map(Number);
  $('#winsTitle').textContent = `${mo}月${d}日の落札結果`;
  // 行の一覧: 1行目に品名、2行目に内訳（落札額＋買歩銭）、右にお支払い額（表にすると、スマホで品名が細く折り返す）
  $('#winsRows').replaceChildren(...res.lines.map((l) => el('li', {},
    el('span', { class: 'winlist__main' }, el('b', { text: l.label }), el('span', { class: 'num', text: `落札額 ${yen(l.amount)}＋買歩銭 ${yen(l.premium)}` })),
    el('b', { class: 'digits winlist__amt', text: yen(l.payable) }))));
  $('#winsCount').textContent = `合計（${res.lines.length}点）`;
  $('#winsAmount').textContent = `落札額 ${yen(res.total.amount)}`;
  $('#winsPremium').textContent = `＋買歩銭 ${yen(res.total.premium)}`;
  $('#winsPayable').textContent = yen(res.total.payable);
  $('#wins').hidden = false;
}
