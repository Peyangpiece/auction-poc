// スタッフ用の管理画面: 受付（来場確認）、開催、会員、スタッフ、設定、記録。商品の登録は、進行コンソールで競りの最中に行う。
// どの操作ができるかは、サーバーが役割で決める。ここでは、できない操作の入口を出さないだけ。
'use strict';

const toConsole = new URLSearchParams(location.search).get('next') === 'console';
const dlg = $('#dlg');
const panel = $('#panel');
let me = null;
let current = null;

function openDialog(title, ...body) {
  dlg.replaceChildren(el('h2', { text: title }), ...body.filter(Boolean));
  if (!dlg.open) dlg.showModal();
}
const closeBtn = (text = '閉じる') => el('button', { class: 'btn', type: 'button', text, onclick: () => dlg.close() });
const msgLine = () => el('p', { class: 'msg', role: 'alert', tabIndex: -1 });
function table(heads, rows, empty) {
  if (!rows.length) return el('p', { class: 'empty', text: empty });
  return el('div', { class: 'tablewrap' }, el('table', {},
    el('thead', {}, el('tr', {}, heads.map((h) => el('th', { scope: 'col', text: h })))),
    el('tbody', {}, rows)));
}
const act = (...buttons) => el('td', { class: 'act' }, buttons);
const smallBtn = (text, onclick, cls = '') => el('button', { class: `btn ${cls}`, type: 'button', text, onclick });
/** 理由を聞いてから実行する、取り消しにくい操作 */
function askReason(title, label, required, run) {
  const form = el('form', { class: 'form', novalidate: true },
    field(label, 'reason', { rows: 3, required }), msgLine(),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '実行する' }), closeBtn('やめる')));
  onSubmit(form, async (data) => {
    const res = await run(data.reason);
    if (res.ok) { dlg.close(); show(current); }
    return res;
  });
  openDialog(title, form);
  form.elements.reason.focus();
}

const alertLine = (text) => { const line = $('#line'); if (line) line.textContent = text; };

// ------------------------------------------------------------ 開催
async function eventsPanel() {
  const res = await api('GET', '/api/events');
  const rows = res.events.map((e) => el('tr', {},
    el('td', { class: 'dyn', text: e.title }),
    el('td', { class: 'n', text: `${e.startsAt.replace('T', ' ')} 〜 ${e.endsAt.slice(11)}` }),
    el('td', { class: 'dyn', text: e.venueName }),
    el('td', { text: e.notified ? '届出済み' : '未届出' }),
    el('td', {}, el('span', { class: 'state', 'data-on': e.status === 'published' ? '1' : '0', text: e.status === 'published' ? '公開中' : '準備中' })),
    act(smallBtn('編集', () => eventDialog(e)),
      e.status !== 'published' && smallBtn('公開する', async () => { const r = await api('POST', `/api/events/${e.id}/publish`); if (!r.ok) alertLine(r.message); else show('events'); }, 'btn-primary'))));
  return [
    el('div', { class: 'toolbar' }, el('p', { class: 'note', text: '公開した開催が、トップページのカレンダーに出ます。届出済みの印がない開催は、公開できません。' }), smallBtn('開催を作る', () => eventDialog(null), 'btn-primary')),
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

// ------------------------------------------------------------ 会員
async function membersPanel() {
  const res = await api('GET', '/api/members');
  const rows = res.members.map((m) => el('tr', {},
    el('td', { class: 'n', text: String(m.id) }),
    el('td', { class: 'dyn' }, m.kind === 'b2b' ? `${m.company}　${m.contactName}` : m.name),
    el('td', { text: m.kind === 'b2b' ? '法人' : '個人' }),
    el('td', { class: 'n', text: m.phone }),
    el('td', { class: 'dyn', text: m.email + (m.emailVerified ? '' : '（未確認）') }),
    el('td', { class: 'dyn' }, m.suspended ? el('span', { class: 'warn', text: `停止中: ${m.suspendReason}` }) : '利用中'),
    act(m.suspended
      ? smallBtn('停止を解く', async () => { await api('POST', `/api/members/${m.id}/unsuspend`); show('members'); })
      : smallBtn('停止', () => askReason(`会員 ${m.id} を停止`, '停止の理由', true, (reason) => api('POST', `/api/members/${m.id}/suspend`, { reason })), 'btn-danger'))));
  return [table(['会員番号', '名前', '区分', '電話番号', 'メール', '状態', ''], rows, '会員はまだいません。')];
}

// ------------------------------------------------------------ 受付: 来場確認（FR-MODE-002・004）と、会場の QR コード
const PAY = { transfer: '銀行振込', cash: '当日現金' };
const RECV = { pickup: '現地受け取り', ship: '配送' };
async function receptionPanel() {
  const res = await api('GET', '/api/reception');
  if (!res.ok) return [el('p', { class: 'msg', text: res.message })];
  if (!res.event) return [el('p', { class: 'empty', text: '本日の開催はありません。' })];
  const waiting = res.participants.filter((p) => p.mode === 'venue' && !p.checkedIn).length;
  const rows = res.participants.map((p) => el('tr', {},
    el('td', { class: 'n paddle', text: String(p.paddle) }),
    el('td', { class: 'dyn', text: p.name }),
    el('td', { text: p.mode === 'venue' ? '会場' : 'オンライン' }),
    el('td', { text: `${RECV[p.receive]}・${PAY[p.payment]}` }),
    el('td', {}, p.mode === 'venue' ? el('span', { class: 'state', 'data-on': p.checkedIn ? '1' : '0', text: p.checkedIn ? '来場確認済み' : '確認待ち' }) : ''),
    act(
      p.mode === 'venue' && !p.checkedIn && smallBtn('来場を確認', async () => { const r = await api('POST', `/api/reception/${p.id}/checkin`); if (!r.ok) alertLine(r.message); show('reception'); }, 'btn-primary'),
      p.mode === 'online' && smallBtn('会場参加に切り替え', () => switchDialog(p)))));
  return [
    el('div', { class: 'toolbar' },
      el('p', { class: 'dyn', text: `${res.event.title}　確認待ち ${waiting} 人` }),
      el('div', {}, smallBtn('更新', () => show('reception')), ' ', smallBtn('会場の QR コード', () => qrDialog(res.event), 'btn-primary'))),
    el('p', { class: 'note', text: '本人と参加番号を確かめてから「来場を確認」を押し、その番号の札を渡してください。' }),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    table(['参加番号', '名前', '参加', '受け取り・支払', '来場', ''], rows, '参加手続きを済ませた人は、まだいません。'),
  ];
}
function switchDialog(p) {
  const form = el('form', { class: 'form', novalidate: true },
    el('p', { text: `参加番号 ${p.paddle} を、オンライン参加から会場参加に切り替えます。支払方法を、本人に聞いて選んでください。` }),
    el('fieldset', { class: 'choice' }, el('legend', { text: '支払方法' }),
      el('label', {}, el('input', { type: 'radio', name: 'payment', value: 'cash' }), '当日現金'),
      el('label', {}, el('input', { type: 'radio', name: 'payment', value: 'transfer' }), '銀行振込')),
    msgLine(),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '切り替えて、来場を確認' }), closeBtn('やめる')));
  onSubmit(form, async (data) => {
    const res = await api('POST', `/api/reception/${p.id}/checkin`, { payment: data.payment });
    if (res.ok) { dlg.close(); show('reception'); }
    return res;
  });
  openDialog('会場参加に切り替え', form);
}
function qrDialog(event) {
  openDialog('会場の QR コード',
    el('p', { class: 'dyn', text: `${event.title}　会場参加の方は、このコードを読み取ってください。` }),
    el('img', { class: 'qr', src: '/api/reception/qr.svg', alt: '会場参加の QR コード', width: 320, height: 320 }),
    el('p', { class: 'note', text: 'このコードは、開催ごとに変わります。会場の中にだけ掲示してください。' }),
    el('div', { class: 'actions' }, smallBtn('印刷', () => window.print()), closeBtn()));
}

// ------------------------------------------------------------ SMS の制限の解除（受付係もできる）
function smsPanel() {
  const form = el('form', { class: 'form', novalidate: true },
    field('電話番号', 'phone', { type: 'tel', inputMode: 'tel', required: true }, '会場で本人を確かめたうえで、認証番号の送信の制限（1時間に5回）を解きます'),
    el('p', { class: 'msg', role: 'alert', tabIndex: -1 }),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '制限を解く' })));
  onSubmit(form, async (data) => {
    const res = await api('POST', '/api/sms-limit/reset', data);
    if (res.ok) { const m = $('.msg', form); m.classList.add('ok'); m.textContent = '制限を解きました'; form.reset(); return null; }
    return res;
  });
  return [el('div', { class: 'narrowcol' }, form)];
}

// ------------------------------------------------------------ スタッフ
async function staffPanel() {
  const res = await api('GET', '/api/staff/accounts');
  const rows = res.staff.map((s) => el('tr', {},
    el('td', { text: s.loginId }), el('td', { class: 'dyn', text: s.name }), el('td', { text: s.roleLabel }),
    el('td', { text: s.active ? '利用中' : '停止' }),
    act(s.active && s.loginId !== me.loginId && smallBtn('停止', async () => { const r = await api('POST', `/api/staff/accounts/${s.id}/stop`); if (!r.ok) alertLine(r.message); else show('staff'); }, 'btn-danger'))));
  return [
    el('div', { class: 'toolbar' }, smallBtn('パスワードを変える', passwordDialog), smallBtn('スタッフを作る', staffDialog, 'btn-primary')),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    table(['ログイン ID', '名前', '役割', '状態', ''], rows, ''),
  ];
}
function staffDialog() {
  const form = el('form', { class: 'form', novalidate: true },
    field('ログイン ID', 'loginId', { required: true, autocapitalize: 'none', spellcheck: false }, '半角の英小文字・数字で 3〜32 文字'),
    field('名前', 'name', { required: true }),
    field('役割', 'role', { options: [['auctioneer', '進行役'], ['reception', '受付係'], ['admin', '主催者管理者']] }),
    field('電話番号', 'phone', { type: 'tel', inputMode: 'tel' }, '任意。この番号では会員登録できなくなります'),
    msgLine(),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '作る' }), closeBtn()));
  onSubmit(form, async (data) => {
    const res = await api('POST', '/api/staff/accounts', data);
    if (res.ok) {
      show('staff');
      openDialog('スタッフを作りました',
        el('p', { text: '次の内容は、この画面を閉じると二度と表示できません。本人に、安全な方法で渡してください。' }),
        el('dl', { class: 'facts' },
          el('dt', { text: 'ログイン ID' }), el('dd', { text: res.loginId }),
          el('dt', { text: '仮のパスワード' }), el('dd', {}, el('div', { class: 'secret', text: res.initialPassword })),
          el('dt', { text: '認証アプリの鍵' }), el('dd', {}, el('div', { class: 'secret', text: res.totpSecret }))),
        el('p', { class: 'note', text: '認証アプリ（Google Authenticator など）で「セットアップキーを入力」を選び、鍵を入れます。種類は「時間ベース」です。' }),
        el('div', { class: 'actions' }, closeBtn('渡したので閉じる')));
    }
    return res;
  });
  openDialog('スタッフを作る', form);
}
function passwordDialog() {
  const form = el('form', { class: 'form', novalidate: true },
    field('いまのパスワード', 'current', { type: 'password', autocomplete: 'current-password', required: true }),
    field('新しいパスワード', 'next', { type: 'password', autocomplete: 'new-password', required: true, minLength: 12 }, '12文字以上'),
    msgLine(),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '変える' }), closeBtn()));
  onSubmit(form, async (data) => {
    const res = await api('POST', '/api/staff/password', data);
    if (res.ok) dlg.close();
    return res;
  });
  openDialog('パスワードを変える', form);
}

// ------------------------------------------------------------ 設定
async function settingsPanel() {
  const s = await api('GET', '/api/settings');
  const form = el('form', { class: 'form', novalidate: true },
    field('主催者の名称', 'orgName', { value: s.orgName, required: true }),
    field('返品特約の表示', 'returnPolicy', { value: s.returnPolicy, rows: 4, required: true }, 'トップページに表示します。弁護士の確認が済むまでは仮の文言です'),
    field('送料の表示', 'shippingNotice', { value: s.shippingNotice, rows: 3, required: true }, 'トップページに表示します'),
    el('p', { class: 'msg', role: 'alert', tabIndex: -1 }),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '保存する' })));
  onSubmit(form, async (data) => {
    const res = await api('POST', '/api/settings', data);
    if (res.ok) { const m = $('.msg', form); m.classList.add('ok'); m.textContent = '保存しました'; return null; }
    return res;
  });
  return [el('div', { class: 'narrowcol' }, form)];
}

// ------------------------------------------------------------ 記録（監査ログ・知らせ）
async function auditPanel() {
  const [audit, notices] = await Promise.all([api('GET', '/api/audit'), api('GET', '/api/notices')]);
  const who = (e) => (e.actor_kind === 'staff' ? `スタッフ ${e.actor_id}` : e.actor_kind === 'member' ? `会員 ${e.actor_id}` : e.actor_kind === 'system' ? 'システム' : '');
  return [
    notices.notices.length ? el('div', { class: 'banner', role: 'alert' }, el('span', { text: `送信に失敗した知らせが ${notices.notices.length} 件あります（SMS・メール）。` })) : null,
    table(['日時', '操作', '誰が', '対象', '前', '後', '理由'], audit.entries.map((e) => el('tr', {},
      el('td', { class: 'n', text: dateFmt.format(e.at) }), el('td', { text: e.type }), el('td', { text: who(e) }), el('td', { text: e.target }),
      el('td', { class: 'dyn', text: e.before ?? '' }), el('td', { class: 'dyn', text: e.after ?? '' }), el('td', { class: 'dyn', text: e.reason ?? '' }))), '記録はまだありません。'),
  ];
}

// ------------------------------------------------------------ 切り替え
const PANELS = {
  reception: ['受付', receptionPanel, ['admin', 'auctioneer', 'reception']],
  events: ['開催', eventsPanel, ['admin']],
  members: ['会員', membersPanel, ['admin']],
  sms: ['SMS の制限', smsPanel, ['admin', 'auctioneer', 'reception']],
  staff: ['スタッフ', staffPanel, ['admin']],
  settings: ['設定', settingsPanel, ['admin']],
  audit: ['記録', auditPanel, ['admin']],
};
async function show(key) {
  current = key;
  for (const b of $('#tabs').children) b.setAttribute('aria-selected', String(b.dataset.key === key));
  const nodes = await PANELS[key][1]();
  if (current === key) panel.replaceChildren(...nodes.filter(Boolean));
}

onSubmit($('#loginForm'), async (data) => {
  const res = await api('POST', '/api/staff/login', data);
  // 進行コンソールから来た人は、ログインのあと進行コンソールへ戻す
  if (res.ok) { if (toConsole && ['admin', 'auctioneer'].includes(res.staff.role)) location.href = '/console.html'; else location.href = '/staff.html'; }
  else $('#loginForm').elements.code.value = '';
  return res;
});

(async () => {
  const state = await setupNav();
  me = state.staff;
  if (!me) { $('#login').hidden = false; $('#loginForm').elements.loginId.focus(); return; }
  $('#app').hidden = false;
  $('#who').textContent = `${me.name}（${me.roleLabel}）`;
  // 競りの進行は、主催者管理者と進行役（8.14）
  $('#toConsole').hidden = !['admin', 'auctioneer'].includes(me.role);
  const keys = Object.keys(PANELS).filter((k) => PANELS[k][2].includes(me.role));
  $('#tabs').replaceChildren(...keys.map((k) => el('button', { type: 'button', role: 'tab', 'data-key': k, text: PANELS[k][0], onclick: () => show(k) })));
  show(keys[0]);
})();
