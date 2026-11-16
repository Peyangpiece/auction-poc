// トップページ: 開催の当日は、開催の案内と「参加する」を大きく出す。その下に、開催日のカレンダー。開催のない日は、カレンダーだけ。
'use strict';

const hm = (t) => t.slice(11).replace(/^0/, '');           // 09:00 → 9:00
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
let schedule = { today: '', events: [] };
let shown = { y: 0, m: 0 }; // 表示している月

function showToday(e) {
  $('#todayTitle').textContent = e.title;
  $('#todayTime').textContent = `${hm(e.startsAt)} 〜 ${hm(e.endsAt)}`;
  $('#todayVenue').textContent = `${e.venueName}（${e.venueAddress}）`;
  const items = e.highlights.split('\n').map((x) => x.trim()).filter(Boolean);
  $('#todayList').replaceChildren(...items.map((text) => el('li', { text })));
  $('#todayItems').hidden = items.length === 0;
  $('#today').hidden = false;
}

function drawCalendar() {
  const { y, m } = shown;
  $('#calMonth').textContent = `${y}年${m}月`;
  const byDay = new Map();
  for (const e of schedule.events) {
    const day = e.startsAt.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const rows = [];
  let row = Array.from({ length: first }, () => el('td', { class: 'cal__blank' }));
  for (let d = 1; d <= days; d++) {
    const key = ymd(y, m, d);
    const events = byDay.get(key);
    const cell = el('td', { class: [events && 'is-event', key === schedule.today && 'is-today', key < schedule.today && 'is-past'].filter(Boolean).join(' ') },
      el('span', { class: 'cal__day digits', text: String(d) }),
      // 色だけに頼らず、言葉でも伝える
      events && el('span', { class: 'cal__mark', text: events.map((e) => hm(e.startsAt)).join(' ') }),
      events && el('span', { class: 'sr-only', text: '開催日' }),
      key === schedule.today && el('span', { class: 'sr-only', text: '今日' }));
    row.push(cell);
    if (row.length === 7) { rows.push(el('tr', {}, row)); row = []; }
  }
  if (row.length) { while (row.length < 7) row.push(el('td', { class: 'cal__blank' })); rows.push(el('tr', {}, row)); }
  $('#calBody').replaceChildren(...rows);

  // その月の開催を、下に一覧でも出す（日付・曜日・時間・名前・会場）
  const prefix = ymd(y, m, 1).slice(0, 7);
  const list = schedule.events.filter((e) => e.startsAt.startsWith(prefix));
  $('#calList').replaceChildren(...(list.length ? list.map((e) => {
    const [yy, mm, dd] = e.startsAt.slice(0, 10).split('-').map(Number);
    const w = WEEK[new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay()];
    return el('li', {},
      el('b', { class: 'digits', text: `${mm}/${dd}（${w}）` }),
      el('span', { class: 'digits', text: `${hm(e.startsAt)} 〜 ${hm(e.endsAt)}` }),
      el('span', { text: `${e.title}　${e.venueName}` }));
  }) : [el('li', { class: 'cal__none', text: 'この月の開催は、まだ決まっていません。' })]));
  // 今月より前には戻さない（終わった月の予定は出していない）
  $('#calPrev').disabled = ymd(y, m, 1).slice(0, 7) <= schedule.today.slice(0, 7);
}
function move(step) {
  const d = new Date(Date.UTC(shown.y, shown.m - 1 + step, 1));
  shown = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
  drawCalendar();
}
$('#calPrev').addEventListener('click', () => move(-1));
$('#calNext').addEventListener('click', () => move(1));

(async () => {
  const [me, res, terms] = await Promise.all([setupNav(), api('GET', '/api/schedule'), api('GET', '/api/terms')]);
  if (res.ok) {
    schedule = res;
    if (res.todayEvent) showToday(res.todayEvent);
  } else {
    // 予定を取れなかったときも、端末の時計の今月でカレンダーは出す
    schedule.today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
  }
  const [y, m] = schedule.today.split('-').map(Number);
  shown = { y, m };
  drawCalendar();
  $('#lead').hidden = !!(me.member || me.staff);
  if (terms.ok) {
    $('#shipping').textContent = terms.shippingNotice;
    $('#returns').textContent = terms.returnPolicy;
    $('#terms').hidden = false;
  }
})();
