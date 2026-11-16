// スタッフ用の管理画面: 商品の登録と審査、開催、会員、スタッフ、設定、記録。
// どの操作ができるかは、サーバーが役割で決める。ここでは、できない操作の入口を出さないだけ。
'use strict';

const dlg = $('#dlg');
const panel = $('#panel');
const STATUS = { draft: '下書き', pending: '審査待ち', approved: '承認済み', rejected: '却下' };
const PHOTO_MAX = 10 * 1024 * 1024;
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

// ------------------------------------------------------------ 商品
async function itemsPanel() {
  const [items, events] = await Promise.all([api('GET', '/api/items'), api('GET', '/api/events')]);
  if (!items.ok) return [el('p', { class: 'msg', text: items.message })];
  const evName = Object.fromEntries(events.events.map((e) => [e.id, e.title]));
  const rows = items.items.map((i) => {
    return el('tr', {},
      el('td', { class: 'n', text: String(i.id) }),
      el('td', { class: 'dyn' }, i.title, i.warnings.length ? el('div', { class: 'warn', text: `出品禁止の言葉: ${i.warnings.join('、')}` }) : null),
      el('td', { class: 'n', text: yen(i.startPrice) }),
      el('td', { class: 'n', text: i.reservePrice === null ? 'なし' : yen(i.reservePrice) }),
      el('td', { class: 'dyn', text: i.eventId ? `${evName[i.eventId] ?? ''}（順 ${i.sortOrder}）` : '未定' }),
      el('td', {}, el('span', { class: 'state', 'data-on': i.status === 'approved' ? '1' : '0', text: STATUS[i.status] })),
      act(
        smallBtn('編集', () => itemDialog(i, events.events)),
        (i.status === 'draft' || i.status === 'rejected') && smallBtn('審査に出す', async () => { const r = await api('POST', `/api/items/${i.id}/submit`); if (!r.ok) alertLine(r.message); show('items'); }),
        i.status === 'pending' && smallBtn('審査', () => reviewDialog(i), 'btn-primary')));
  });
  return [
    el('div', { class: 'toolbar' }, el('p', { class: 'note', text: '登録・変更した本人は、その商品を審査できません。' }), smallBtn('商品を登録', () => itemDialog(null, events.events), 'btn-primary')),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    table(['番号', '商品名', '開始価格', '最低落札額', '開催', '状態', ''], rows, '商品はまだありません。'),
  ];
}
const alertLine = (text) => { const line = $('#line'); if (line) line.textContent = text; };

function itemDialog(item, events) {
  const i = item ?? { title: '', description: '', quantity: 1, startPrice: '', unitOverride: null, reservePrice: null, size: '', condition: '', surplusInfo: '', eventId: null, sortOrder: 0, photos: [] };
  const form = el('form', { class: 'form', novalidate: true },
    field('商品名', 'title', { value: i.title, required: true, maxLength: 120 }),
    el('div', { class: 'grid2' },
      field('開始価格（税込・円）', 'startPrice', { value: i.startPrice, inputMode: 'numeric', required: true }),
      field('数量', 'quantity', { value: i.quantity, inputMode: 'numeric' }),
      field('最低落札額（円）', 'reservePrice', { value: i.reservePrice ?? '', inputMode: 'numeric' }, '任意。参加者には見せません'),
      field('入札単位（円）', 'unitOverride', { value: i.unitOverride ?? '', inputMode: 'numeric' }, '任意。空なら既定の表')),
    field('説明', 'description', { value: i.description, rows: 3 }),
    el('div', { class: 'grid2' },
      field('サイズ', 'size', { value: i.size }),
      field('状態', 'condition', { value: i.condition })),
    field('放出品の情報', 'surplusInfo', { value: i.surplusInfo }, '放出元・年式など'),
    el('div', { class: 'grid2' },
      field('出品する開催', 'eventId', { options: [['', '未定'], ...events.map((e) => [String(e.id), e.title])], value: i.eventId === null ? '' : String(i.eventId) }),
      field('出品順', 'sortOrder', { value: i.sortOrder, inputMode: 'numeric' }, '小さい順に No. を振ります')),
    item && item.status === 'approved' && el('p', { class: 'note', text: '承認済みです。出品順と開催のほかを変えると、審査待ちに戻ります。' }),
    msgLine(),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: item ? '保存する' : '登録して写真へ進む' }), closeBtn()));
  onSubmit(form, async (data) => {
    const res = await api('POST', item ? `/api/items/${item.id}` : '/api/items', data);
    if (res.ok) {
      show('items');
      if (item) dlg.close();
      else { const fresh = (await api('GET', '/api/items')).items.find((x) => x.id === res.id); itemDialog(fresh, events); }
    }
    return res;
  });
  const photos = el('div', { class: 'photos' });
  const drawPhotos = (list) => {
    const input = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, class: 'sr-only', id: 'photoInput' });
    const line = msgLine();
    input.addEventListener('change', async () => {
      let latest = list;
      for (const file of input.files) {
        if (file.size > PHOTO_MAX) { line.textContent = `${file.name}: 写真は、1枚 10MB までです`; continue; }
        const res = await api('POST', `/api/items/${item.id}/photos`, file);
        if (!res.ok) { line.textContent = `${file.name}: ${res.message}`; break; }
        latest = res.photos;
      }
      const keep = line.textContent;
      drawPhotos(latest);
      $('.msg', photos).textContent = keep;
      show('items');
    });
    photos.replaceChildren(
      el('h2', { text: `写真（${list.length} / 20）` }),
      el('div', { class: 'gallery' }, list.map((p, n) => el('figure', {},
        el('img', { src: p.url, alt: `写真 ${n + 1}`, loading: 'lazy' }),
        smallBtn('削除', async () => { const r = await api('POST', `/api/photos/${p.id}/delete`); if (r.ok) { drawPhotos(r.photos); show('items'); } })))),
      input,
      el('label', { class: 'btn', htmlFor: 'photoInput', text: '写真を追加' }),
      el('p', { class: 'note', text: 'JPEG・PNG・WebP、1枚 10MB まで' }),
      line);
  };
  if (item) drawPhotos(i.photos);
  openDialog(item ? `商品 ${item.id} の編集` : '商品を登録', form, photos);
}

async function reviewDialog(i) {
  const history = await api('GET', `/api/items/${i.id}/reviews`);
  const facts = [['商品名', i.title], ['開始価格（税込）', yen(i.startPrice)], ['最低落札額', i.reservePrice === null ? 'なし' : yen(i.reservePrice)], ['数量', String(i.quantity)], ['サイズ', i.size], ['状態', i.condition], ['放出品の情報', i.surplusInfo], ['説明', i.description]];
  const form = el('form', { class: 'form', novalidate: true },
    i.warnings.length ? el('p', { class: 'warn', role: 'alert', text: `出品禁止の言葉が含まれています: ${i.warnings.join('、')}。承認する場合は、判断の理由が必要です。` }) : null,
    field('判断の理由', 'reason', { rows: 3 }, i.warnings.length ? '承認・却下のどちらでも必須' : '却下のときは必須'),
    msgLine(),
    el('div', { class: 'actions' },
      el('button', { class: 'btn btn-primary', type: 'submit', value: 'approved', text: '承認する' }),
      el('button', { class: 'btn btn-danger', type: 'submit', value: 'rejected', text: '却下する' }), closeBtn()));
  onSubmit(form, async (data, button) => {
    const res = await api('POST', `/api/items/${i.id}/review`, { decision: button.value, reason: data.reason });
    if (res.ok) { dlg.close(); show('items'); }
    return res;
  });
  openDialog(`商品 ${i.id} の審査`,
    el('div', { class: 'gallery' }, i.photos.map((p, n) => el('figure', {}, el('img', { src: p.url, alt: `写真 ${n + 1}` })))),
    el('dl', { class: 'facts' }, facts.filter(([, v]) => v).flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { class: 'pre dyn', text: v })])),
    history.ok && history.reviews.length ? el('div', {}, el('h2', { text: 'これまでの審査' }),
      el('ul', { class: 'rows' }, history.reviews.map((r) => el('li', { class: 'dyn', text: `${dateFmt.format(r.at)}　${r.reviewer}　${STATUS[r.decision]}${r.reason ? '　' + r.reason : ''}` })))) : null,
    form);
}

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
    el('div', { class: 'toolbar' }, el('p', { class: 'note', text: '公安委員会への届出済みの印がない開催は、公開できません。' }), smallBtn('開催を作る', () => eventDialog(null), 'btn-primary')),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    table(['名前', '日時', '会場', '届出', '状態', ''], rows, '開催はまだありません。'),
  ];
}
function eventDialog(e) {
  const v = e ?? { title: '', startsAt: '', endsAt: '', venueName: '', venueAddress: '', notified: false };
  const form = el('form', { class: 'form', novalidate: true },
    field('開催の名前', 'title', { value: v.title, required: true }),
    el('div', { class: 'grid2' },
      field('開始', 'startsAt', { type: 'datetime-local', value: v.startsAt, required: true }),
      field('終了', 'endsAt', { type: 'datetime-local', value: v.endsAt, required: true })),
    field('会場の名称', 'venueName', { value: v.venueName, required: true }),
    field('会場の住所', 'venueAddress', { value: v.venueAddress, required: true }),
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
    field('返品特約の表示', 'returnPolicy', { value: s.returnPolicy, rows: 4, required: true }, 'カタログに表示します。弁護士の確認が済むまでは仮の文言です'),
    field('送料の表示', 'shippingNotice', { value: s.shippingNotice, rows: 3, required: true }, 'カタログに表示します'),
    field('出品禁止の言葉', 'bannedWords', { value: s.bannedWords.join('\n'), rows: 6 }, '1行に1つ。商品の文面に含まれると、審査で警告を出します'),
    el('p', { class: 'msg', role: 'alert', tabIndex: -1 }),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '保存する' })));
  onSubmit(form, async (data) => {
    const res = await api('POST', '/api/settings', { ...data, bannedWords: data.bannedWords.split('\n') });
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
  items: ['商品', itemsPanel, ['admin', 'auctioneer']],
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
  if (res.ok) location.reload();
  else $('#loginForm').elements.code.value = '';
  return res;
});

(async () => {
  const state = await setupNav();
  me = state.staff;
  if (!me) { $('#login').hidden = false; $('#loginForm').elements.loginId.focus(); return; }
  $('#app').hidden = false;
  $('#who').textContent = `${me.name}（${me.roleLabel}）`;
  const keys = Object.keys(PANELS).filter((k) => PANELS[k][2].includes(me.role));
  $('#tabs').replaceChildren(...keys.map((k) => el('button', { type: 'button', role: 'tab', 'data-key': k, text: PANELS[k][0], onclick: () => show(k) })));
  show(keys[0]);
})();
