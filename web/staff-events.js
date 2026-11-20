// 管理画面: 開催（報告書 122 章で、staff.js から分けた。読み込む順番は staff.html のとおり。名前は、ファイルをまたいで共有する）
'use strict';

// ------------------------------------------------------------ 開催
// 今日の日付（日本時間。YYYY-MM-DD）
const todayStr = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
async function eventsPanel() {
  const res = await api('GET', '/api/events');
  const rows = res.events.map((e) => el('tr', {},
    el('td', { class: 'dyn', text: e.title }),
    el('td', { class: 'n', text: `${jpDay(e.startsAt)} ${e.startsAt.slice(11)} 〜 ${e.endsAt.slice(11)}` }),
    el('td', { class: 'dyn', text: e.venueName }),
    el('td', { text: e.notified ? '届出済み' : '未届出' }),
    el('td', {}, el('span', { class: e.stale ? 'state warn' : 'state', 'data-on': e.status === 'published' && !e.ended ? '1' : '0', text: e.ended ? '終了' : e.stale ? '終了していません' : e.status === 'published' ? '公開中' : '準備中' })),
    act(!e.ended && smallBtn('編集', () => eventDialog(e)),
      // 公開は、取り消せず、お知らせメールが出るので、確かめる（本番運用の評価 B18）
      e.status !== 'published' && smallBtn('公開する', () => confirmDo(`「${e.title}」を公開しますか？`,
        '会員のトップページに出ます。開催の前日・当日には、受け取りに同意した会員へ、お知らせメールが届きます。公開は取り消せません。', '公開する',
        () => api('POST', `/api/events/${e.id}/publish`), { then: () => show('events') }), 'btn-primary'),
      // 終了の操作を忘れた開催を、ここから終える（本番運用の評価 A5）
      e.status === 'published' && !e.ended && e.startsAt.slice(0, 10) <= todayStr() && smallBtn('開催を終了…', () => confirmDo(`「${e.title}」を終了しますか？`,
        `待機の品${e.stale ? 'と、進行中のまま残った品' : ''}を、未実施にします（落札にはしません）。まだ請求書のない落札は、落札者ごとに振込の請求書にまとめます。終了は取り消せません。`, '終了して、請求書を作る',
        () => api('POST', `/api/events/${e.id}/end`), { danger: true, then: () => show('events') })))));
  const stale = res.events.filter((e) => e.stale);
  return [
    el('div', { class: 'toolbar' }, smallBtn('開催を作る', () => eventDialog(null), 'btn-primary')),
    stale.length ? el('p', { class: 'notice', role: 'status' }, el('span', { class: 'notice__icon', 'aria-hidden': 'true' }),
      el('span', { text: `終了の操作をしていない、過ぎた日の開催が ${stale.length} 件あります。終了すると、請求書を作れます。` })) : null,
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    table(['名前', '日時', '会場', '届出', '状態', ''], rows, '開催はまだありません。'),
  ];
}
function eventDialog(e) {
  const v = e ?? { title: '', startsAt: '', endsAt: '', venueName: '', venueAddress: '', highlights: '', notified: false };
  const form = el('form', { class: 'form', novalidate: true },
    field('開催の名前', 'title', { value: v.title, required: true }),
    el('div', { class: 'grid2' },
      field('開始', 'startsAt', { type: 'datetime-local', value: v.startsAt, required: true }),
      field('終了', 'endsAt', { type: 'datetime-local', value: v.endsAt, required: true })),
    field('会場の名称', 'venueName', { value: v.venueName, required: true }),
    field('会場の住所', 'venueAddress', { value: v.venueAddress, required: true }),
    field('目玉商品', 'highlights', { value: v.highlights, rows: 4 }, '1行に1つ。開催の当日、トップページに「本日の目玉商品」として表示します'),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'notified', value: '1', checked: v.notified }), el('span', { text: '公安委員会への届出が済んでいる' })),
    msgLine(),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '保存する' }), closeBtn()));
  onSubmit(form, async (data) => {
    const res = await api('POST', e ? `/api/events/${e.id}` : '/api/events', { ...data, notified: data.notified === '1' });
    if (res.ok) { dlg.close(); show('events'); }
    return res;
  });
  openDialog(e ? '開催の編集' : '開催を作る', form);
}
