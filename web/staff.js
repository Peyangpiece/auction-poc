// スタッフ用の管理画面: 受付（来場確認）、開催、会員、スタッフ、設定、記録。商品の登録は、進行コンソールで競りの最中に行う。
// どの操作ができるかは、サーバーが役割で決める。ここでは、できない操作の入口を出さないだけ。
'use strict';

const toConsole = new URLSearchParams(location.search).get('next') === 'console';
const toCaller = new URLSearchParams(location.search).get('next') === 'caller';
const toMonitor = new URLSearchParams(location.search).get('next') === 'monitor';
const dlg = $('#dlg');
const panel = $('#panel');
let me = null;
let S_missing = []; // 公開の前に入れておく項目（「設定」の上に出す）
let current = null;

function openDialog(title, ...body) {
  dlg.replaceChildren(el('h2', { id: 'dlgTitle', text: title }), ...body.filter(Boolean));
  if (!dlg.open) dlg.showModal();
}
const closeBtn = (text = '閉じる') => el('button', { class: 'btn', type: 'button', text, onclick: () => dlg.close() });
const msgLine = () => el('p', { class: 'msg', role: 'alert', tabIndex: -1 });
function table(heads, rows, empty) {
  if (!rows.length) return el('p', { class: 'empty', text: empty });
  return el('div', { class: 'tablewrap' }, el('table', {},
    // 見出しのない列（選ぶ印・操作のボタン）にも、読み上げ用の名前を付ける
    el('thead', {}, el('tr', {}, heads.map((h, i) => (h ? el('th', { scope: 'col', text: h }) : el('th', { scope: 'col' }, el('span', { class: 'sr-only', text: i === 0 ? '選択' : '操作' })))))),
    el('tbody', {}, rows)));
}
// 行の操作が3つ以上あるときは、主な1つ（紺のボタン）だけを見せ、ほかは「⋯」の中にまとめる（ボタンが縦に積み上がらないように。報告書 83 章）
let menuSeq = 0;
function moreMenu(items) {
  const id = `more${++menuSeq}`;
  const pop = el('div', { class: 'more', id, popover: 'auto', role: 'menu' }, items);
  const btn = el('button', { class: 'btn more__btn', type: 'button', 'aria-label': 'ほかの操作', 'aria-haspopup': 'menu', 'aria-expanded': 'false', text: '⋯' });
  btn.setAttribute('popovertarget', id);
  pop.addEventListener('toggle', (ev) => {
    const open = ev.newState === 'open';
    btn.setAttribute('aria-expanded', String(open));
    if (!open) return;
    // ボタンのすぐ下、右端をそろえて出す（画面の下にはみ出すときは、上に）
    const r = btn.getBoundingClientRect();
    const below = r.bottom + 4 + pop.offsetHeight <= innerHeight - 8;
    pop.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - 4 - pop.offsetHeight)}px`;
    pop.style.left = `${Math.max(8, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8))}px`;
    pop.querySelector('button, a')?.focus();
  });
  for (const it of items) { it.setAttribute('role', 'menuitem'); it.classList.add('more__item'); it.addEventListener('click', () => pop.hidePopover()); }
  pop.addEventListener('keydown', (ev) => {
    const all = [...pop.querySelectorAll('.more__item')]; const i = all.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); all[(i + (ev.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus(); }
  });
  return [btn, pop];
}
/** 「書き出す」のように、名前のあるボタンから開く一覧 */
function exportMenu(items) { const [btn, pop] = moreMenu(items); btn.textContent = '書き出す'; btn.removeAttribute('aria-label'); btn.classList.add('more__btn--text'); return el('span', {}, btn, pop); }
const act = (...buttons) => {
  const list = buttons.flat().filter(Boolean);
  if (list.length <= 2) return el('td', { class: 'act' }, list); // 2つまでは、そのまま並べる
  const main = list.find((b) => b.classList.contains('btn-primary')) ?? null;
  return el('td', { class: 'act' }, main, moreMenu(list.filter((b) => b !== main)));
};
const smallBtn = (text, onclick, cls = '') => el('button', { class: `btn ${cls}`, type: 'button', text, onclick });
/** 理由を聞いてから実行する、取り消しにくい操作 */
function askReason(title, label, required, run, okText = '実行する', danger = true) {
  // 実行のボタンは、操作の名前にする（「実行する」では、何が起きるかが分からない。報告書 81 章）
  const form = el('form', { class: 'form', novalidate: true },
    field(label, 'reason', { rows: 3, required }), msgLine(),
    el('div', { class: 'actions' }, el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'submit', text: okText }), closeBtn('やめる')));
  onSubmit(form, async (data) => {
    const res = await run(data.reason);
    if (res.ok) { dlg.close(); show(current); }
    return res;
  });
  openDialog(title, form);
  form.elements.reason.focus();
}

// 受付は、ひらいているあいだ 15 秒ごとに読み直す（「更新」のボタンをなくした。報告書 83 章）。
// 操作の途中（ダイアログ・一覧のメニューを開いている、欄に書いている）は読み直さない
setInterval(() => {
  if (current !== 'reception' || document.hidden || dlg.open || document.querySelector('.more:popover-open')) return;
  if (document.activeElement !== panel && panel.contains(document.activeElement)) return; // キーボードで一覧を操作している途中も、読み直さない
  show('reception');
}, 15000);
// 設定・規約類に入れたまま、ほかのタブに移ると、入力が消える。移る前に確かめる（報告書 81 章）
let unsaved = false;
panel.addEventListener('input', (ev) => { if (current === 'settings' && ev.target.closest('form')) unsaved = true; });
addEventListener('beforeunload', (ev) => { if (unsaved) ev.preventDefault(); });
function leavePanel(go) {
  if (!unsaved) return go();
  confirmDo('保存していない入力があります', 'ほかのタブに移ると、設定・規約類に入れた内容は消えます。', '保存せずに移る', async () => ({ ok: true }), { danger: true, then: async () => { unsaved = false; go(); } });
}
// 知らせは、パネルを描き直したあとも残す（操作のあとに show() で描き直すため、先に出した文が消えていた。報告書 80 章）
let pendingNotice = null;
const alertLine = (text) => { pendingNotice = text || null; const line = $('#line'); if (line) line.textContent = text; };

/** 取り消せない・取り消しにくい操作の確かめ。何が起きるかを書き、最初のフォーカスは「やめる」 */
function confirmDo(title, body, okText, run, { danger = false, then = null } = {}) {
  const msg = msgLine();
  const cancel = closeBtn('やめる');
  const ok = el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', text: okText, onclick: async () => {
    ok.disabled = true; ok.textContent = '処理中…';
    const r = await run();
    ok.disabled = false; ok.textContent = okText;
    if (!r?.ok) { msg.textContent = r?.message ?? 'うまくいきませんでした。もう一度お試しください'; msg.focus(); return; }
    dlg.close();
    if (then) await then(r); else await show(current);
  } });
  openDialog(title, el('p', { text: body }), msg, el('div', { class: 'actions' }, cancel, ok));
  cancel.focus();
}

// ログインが切れたら（12時間・パスワードの再発行・停止）、ログインの画面に戻す（報告書 80 章）
{
  const rawApi = api;
  api = async (...args) => {
    const r = await rawApi(...args);
    if (r.status === 401 && me) { location.reload(); return new Promise(() => {}); }
    return r;
  };
}

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

// ------------------------------------------------------------ 会員
// 写し取るボタン（手で打ち直すと、まちがえやすい）
function copyBtn(text) {
  const b = el('button', { class: 'btn copybtn', type: 'button', text: 'コピー' });
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); b.textContent = 'コピーしました'; } catch { b.textContent = 'コピーできません'; }
    setTimeout(() => { b.textContent = 'コピー'; }, 2000);
  });
  return b;
}
// ログイン ID とパスワードを発行したあとの知らせ。メールで送った旨を出す。お試し用の設定のときだけ、内容も出す
function issuedDialog(title, res) {
  openDialog(title,
    res.devPassword
      ? el('p', { text: `ログイン ID とパスワードを発行しました。下の内容を、${res.name ?? '本人'}にお伝えください（お試し用の設定では、メールは送られません）。` })
      : res.sent === false
      ? el('p', { class: 'warn', role: 'alert', text: `${res.email} へのメールを、送れませんでした。少し待ってから、会員の一覧の「ログイン情報を発行」で、送り直してください。` })
      : el('p', { text: `ログイン ID とパスワードを、${res.email} へメールで送りました。` }),
    res.devPassword && el('dl', { class: 'facts' },
      el('dt', { text: 'ログイン ID' }), el('dd', { class: 'copyrow' }, noTranslate(el('div', { class: 'secret', text: res.loginId })), copyBtn(res.loginId)),
      el('dt', { text: 'パスワード' }), el('dd', { class: 'copyrow' }, noTranslate(el('div', { class: 'secret', text: res.devPassword })), copyBtn(res.devPassword))),
    res.devPassword && el('p', { class: 'note', text: '【お試し用】メールの送信サービスをつなぐ前なので、ここに表示しています。本番では、表示されません。' }),
    el('div', { class: 'actions' }, closeBtn('閉じる')));
}
async function issue(url, title) {
  const r = await api('POST', url);
  if (!r.ok) { alertLine(r.message); return; }
  await show('members');
  issuedDialog(title, r);
}
// 一覧の件数: 既定は新しい順の決まった件数。「さらに前の分も表示する」で倍に広げる（本番運用の評価 C）
const listLimits = {};
const withLimit = (url, key) => (listLimits[key] ? `${url}${url.includes('?') ? '&' : '?'}limit=${listLimits[key]}` : url);
function moreBtn(key, res, what) {
  if (!res.more) return null;
  return el('p', { class: 'note' }, `${what}は、新しい順に ${res.limit.toLocaleString()} 件（と、対応の残っているもの）を出しています。`,
    smallBtn('さらに前の分も表示する', () => { listLimits[key] = Math.min(50000, res.limit * 2); show(current); }));
}
async function membersPanel() {
  const res = await api('GET', withLimit('/api/members', 'members'));
  const waiting = res.members.filter((m) => !m.approved && !m.withdrawn).length;
  const rows = res.members.map((m) => el('tr', {},
    el('td', { class: 'n', text: String(m.id) }),
    // 区分の列はなくし、法人のときだけ名前の横に印を付ける（ほとんどが個人のため。報告書 83 章）
    el('td', { class: 'dyn' }, m.kind === 'b2b' ? [`${m.company}　${m.contactName}`, ' ', el('span', { class: 'tag', text: '法人' })] : m.name),
    el('td', { text: m.loginId ?? '' }),
    el('td', { class: 'n', text: telFmt(m.phone) }),
    el('td', { class: 'dyn', text: m.email + (m.emailVerified ? '' : '（未確認）') }),
    el('td', { class: 'dyn' }, m.rejected ? '承認しなかった' : m.withdrawn ? '退会' : !m.approved ? el('span', { class: 'warn', text: '承認待ち' }) : m.suspendedBy === 'manual' ? el('span', { class: 'warn', text: `停止中: ${m.suspendReason}` })
      : m.suspendedBy === 'unpaid' ? el('span', { class: 'warn', text: '未払いによる停止（消し込むと、自動で解ける）' }) : '利用中'),
    act(
      !m.approved && !m.withdrawn && smallBtn('承認する', () => issue(`/api/members/${m.id}/approve`, `会員 ${m.id} を承認しました`), 'btn-primary'),
      !m.approved && !m.withdrawn && smallBtn('承認しない', () => askReason(`会員 ${m.id} の登録を承認しない`, '理由', true, (reason) => api('POST', `/api/members/${m.id}/reject`, { reason }), '承認しない'), 'btn-danger'),
      m.approved && !m.withdrawn && smallBtn(m.loginId ? 'パスワードを再発行' : 'ログイン情報を発行', () => (m.loginId
        ? confirmDo(`会員 ${m.id} のパスワードを再発行しますか？`, 'いまのパスワードは使えなくなります。新しいパスワードを、本人へメールで送ります。', '再発行する',
          () => api('POST', `/api/members/${m.id}/credentials`), { danger: true, then: async (r) => { await show('members'); issuedDialog(`会員 ${m.id} のログイン情報を発行しました`, r); } })
        : issue(`/api/members/${m.id}/credentials`, `会員 ${m.id} のログイン情報を発行しました`))),
      !m.withdrawn && smallBtn('電話番号を変更', () => askForm(`会員 ${m.id} の電話番号を変更`, '',
        [field('新しい電話番号', 'phone', { type: 'tel', inputMode: 'tel', required: true }), field('本人を確かめた方法', 'reason', { required: true, placeholder: '会場で、運転免許証で確かめた' })], (d) => api('POST', `/api/members/${m.id}/phone`, d), '変更する')),
      m.suspendedBy === 'manual'
      ? smallBtn('停止を解く', () => post(`/api/members/${m.id}/unsuspend`))
      : !m.withdrawn && m.suspendedBy !== 'unpaid' && smallBtn('停止', () => askReason(`会員 ${m.id} を停止`, '停止の理由', true, (reason) => api('POST', `/api/members/${m.id}/suspend`, { reason }), '停止する'), 'btn-danger'))));
  return [el('p', { class: 'msg', id: 'line', role: 'alert' }),
    waiting ? el('div', { class: 'banner', role: 'status' }, el('span', { text: `承認待ちの会員登録が ${waiting} 件あります。承認すると、ログイン ID とパスワードが、本人へメールで送られます。` })) : null,
    table(['会員番号', '名前', 'ログイン ID', '電話番号', 'メール', '状態', ''], rows, '会員はまだいません。'),
    moreBtn('members', res, '会員の一覧')];
}

// ------------------------------------------------------------ 受付: 来場確認（FR-MODE-002・004）と、会場の QR コード
const PAY = { transfer: '銀行振込', cash: '当日現金' };
const RECV = { pickup: '現地受け取り', ship: '配送' };
async function receptionPanel() {
  const res = await api('GET', '/api/reception');
  if (!res.ok) return [el('p', { class: 'msg', text: res.message })];
  // 開催がない日: 次にすることへの道を出す（開催を作れるのは主催者管理者だけ。報告書 82 章）
  if (!res.event) return [el('div', { class: 'empty' }, el('p', { text: '本日の開催はありません。' }),
    me.role === 'admin' && smallBtn('開催を開く', () => leavePanel(() => { pendingNotice = null; show('events'); })))];
  const waiting = res.participants.filter((p) => p.mode === 'venue' && !p.checkedIn).length;
  // 受付でやることがある人（来場の確認待ち）を上に。「参加」と「来場」の列は、1つの「状態」にまとめた（報告書 90 章）
  const order = (p) => (p.mode === 'venue' && !p.checkedIn ? 0 : p.mode === 'venue' ? 1 : 2);
  const sorted = [...res.participants].sort((a, b) => order(a) - order(b) || a.paddle - b.paddle);
  const rows = sorted.map((p) => el('tr', {},
    el('td', { class: 'n paddle', text: String(p.paddle) }),
    el('td', { class: 'dyn', text: p.name }),
    el('td', {}, p.mode === 'venue'
      ? el('span', { class: 'state', 'data-on': p.checkedIn ? '1' : '0', text: p.checkedIn ? '来場確認済み' : '確認待ち' })
      : el('span', { class: 'state state--quiet', text: 'オンライン' })),
    el('td', { class: 'note', text: `${RECV[p.receive]}・${PAY[p.payment]}` }),
    act(
      p.mode === 'venue' && !p.checkedIn && smallBtn('来場を確認', async () => { const r = await api('POST', `/api/reception/${p.id}/checkin`); if (!r.ok) alertLine(r.message); show('reception'); }, 'btn-primary'),
      p.mode === 'online' && smallBtn('会場参加にする', () => switchDialog(p)))));
  return [
    el('div', { class: 'toolbar' },
      el('p', { class: 'dyn', text: `${res.event.title}　確認待ち ${waiting} 人` }),
      el('div', { class: 'toolbar__acts' },
        smallBtn('参加手続きを代わりに行う', () => askForm('参加手続きを、代わりに行う', '',
          [field('会員の電話番号', 'phone', { type: 'tel', inputMode: 'tel', required: true }),
            field('受け取り方法', 'receive', { options: [['', '選んでください'], ['pickup', '現地受け取り'], ['ship', '配送']] }),
            field('支払方法', 'payment', { options: [['', '選んでください'], ['cash', '当日現金'], ['transfer', '銀行振込']] })],
          async (d) => { const r = await api('POST', '/api/reception/join', d); if (r.ok) alertLine(`参加番号 ${r.paddle} を振りました。この番号の札を渡してください。`); return r; }, '参加番号を振る')), ' ',
        smallBtn('会場の QR コード', () => qrDialog(res.event)), ' ',
        smallBtn('QR コードを読み取る', scanDialog, 'btn-primary'))),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    (() => { const t = table(['参加番号', '名前', '状態', '受け取り・支払', ''], rows, '参加手続きを済ませた人は、まだいません。'); t.classList.add('reclist'); return t; })(),
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
// 来場確認の QR コードを、受付のスマホのカメラで読み取る（報告書 91 章）。
// 読み取ったら名前と参加番号を出し、受付係が本人と見比べてから「来場を確認」を押す。終わると、そのまま次の人を読み取る
let jsQRLoad = null;
const loadJsQR = () => (jsQRLoad ??= new Promise((resolve, reject) => {
  const s = el('script', { src: '/jsqr.js' });
  s.onload = () => resolve(window.jsQR);
  s.onerror = () => { jsQRLoad = null; reject(new Error('load')); };
  document.head.append(s);
}));
async function scanDialog() {
  const video = el('video', { class: 'scanvideo', playsInline: true, muted: true, 'aria-hidden': 'true' });
  const say = el('p', { class: 'scanhint', role: 'status', text: 'カメラを準備しています…' });
  const result = el('div', { class: 'scanresult', 'aria-live': 'polite' });
  const canvas = document.createElement('canvas');
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
  let stream = null, timer = 0, busy = false, done = 0, last = { code: '', at: 0 };
  const stop = () => { clearTimeout(timer); timer = 0; stream?.getTracks().forEach((t) => t.stop()); stream = null; };
  openDialog('QR コードを読み取る', say, el('div', { class: 'scanbox' }, video), result,
    el('div', { class: 'actions' }, closeBtn()));
  dlg.addEventListener('close', () => { stop(); if (done) show('reception'); }, { once: true });
  const fail = (text) => { stop(); say.textContent = text; video.hidden = true; };
  let jsQR;
  try { jsQR = await loadJsQR(); } catch { return fail('読み取りの準備ができませんでした。通信の状態を確かめて、開き直してください。一覧からも確認できます。'); }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (e) {
    return fail(e?.name === 'NotAllowedError'
      ? 'カメラの使用が許可されていません。ブラウザの設定でこのサイトのカメラを許可してから、もう一度開いてください。一覧からも確認できます。'
      : 'カメラを使えませんでした。ほかのアプリがカメラを使っていないか確かめてください。一覧からも確認できます。');
  }
  if (!dlg.open) return stop(); // 準備の間に閉じられた
  video.srcObject = stream;
  await video.play().catch(() => {});
  say.textContent = '参加者の入札画面の QR コードを、枠の中に入れてください';
  const next = (ms = 150) => { if (stream) timer = setTimeout(tick, ms); };
  const tick = async () => {
    if (!stream || busy || video.readyState < 2) return next();
    const scale = Math.min(1, 640 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);
    const hit = jsQR(ctx2d.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
    // 同じコードが枠に残っていても、続けて何度も読まない
    if (!hit?.data || (hit.data === last.code && Date.now() - last.at < 5000)) return next();
    last = { code: hit.data, at: Date.now() };
    busy = true;
    navigator.vibrate?.(30);
    const r = await api('POST', '/api/reception/scan', { code: hit.data });
    busy = false;
    showHit(r);
    next(400);
  };
  const showHit = (r) => {
    if (!r.ok) { result.replaceChildren(el('p', { class: 'msg', text: r.message })); return; }
    const head = el('p', { class: 'scanwho' }, el('b', { class: 'n', text: `参加番号 ${r.paddle}` }), el('span', { class: 'dyn', text: r.name }));
    if (r.mode !== 'venue') {
      result.replaceChildren(head, el('p', { class: 'msg', text: 'オンライン参加になっています。会場参加にするときは、一覧の「会場参加にする」から切り替えてください。' }));
      return;
    }
    if (r.checkedIn) { result.replaceChildren(head, el('p', { class: 'note', text: '来場確認済みです。' })); return; }
    const msg = msgLine();
    const ok = el('button', { class: 'btn btn-primary', type: 'button', text: '来場を確認', onclick: async () => {
      ok.disabled = true;
      const c = await api('POST', `/api/reception/${r.id}/checkin`);
      if (!c.ok) { ok.disabled = false; msg.textContent = c.message; return; }
      done++;
      result.replaceChildren(head, el('p', { class: 'scandone', text: `来場を確認しました。参加番号 ${r.paddle} の札を渡してください。` }));
    } });
    result.replaceChildren(head, el('p', { class: 'note', text: `${RECV[r.receive]}・${PAY[r.payment]}。本人か確かめてから押してください。` }), ok, msg);
    ok.focus();
  };
  next(0);
}
function qrDialog(event) {
  openDialog('会場の QR コード',
    el('p', { class: 'dyn', text: `${event.title}　会場参加の方は、このコードを読み取ってください。` }),
    el('img', { class: 'qr', src: '/api/reception/qr.svg', alt: '会場参加の QR コード', width: 320, height: 320 }),
    el('div', { class: 'actions' }, smallBtn('印刷', () => window.print()), closeBtn()));
}

// ------------------------------------------------------------ 請求: 精算・消し込み・引き渡し・未払いの対応・請求書
const LINE_STATE = { unsettled: '未精算', billed: '請求済み', unpaid: '未払い', cleared: '消し込み済み', delivered: '引き渡し済み', cancelled: '解除' };
const INV_KIND = { cash: '現金の精算', transfer: '振込', promote: '繰り上げ', penalty: '違約金など' };
const isAdmin = () => me.role === 'admin';
// 送料: 金額と内容（運送会社・大きさなど）を、あとから手で入れる。まだ送っていない請求書があれば、その請求書に足す
const shippingForm = (accountId, eventId, name, now = null) => askForm('送料を入力', `${name}。金額は、あとから直せます（請求書を「送付済み」にするまで）。0円で、送料の行を消します。`,
  [field('送料（円・税込）', 'amount', { inputMode: 'numeric', required: true, value: now?.amount ?? '' }), field('内容', 'label', { value: (now?.label ?? '').replace('【送料】', ''), placeholder: 'ヤマト運輸 120サイズ' }, '請求書に「【送料】」に続けて載ります')],
  (d) => api('POST', '/api/billing/shipping', { accountId, eventId, amount: Number(d.amount), label: d.label }), '請求書に反映する');
// 認証アプリに読み取らせる QR コード（画像として出す）
// パスワードや鍵は、ブラウザの自動翻訳で書き換えられないようにする
const noTranslate = (node) => { node.setAttribute('translate', 'no'); return node; };
const qrImg = (svg) => el('img', { class: 'qr', alt: '認証アプリ用の QR コード', width: 200, height: 200, src: 'data:image/svg+xml;base64,' + btoa(svg) });
const secretsDialog = (title, res) => openDialog(title,
  el('p', { text: '次の内容は、この画面を閉じると二度と表示できません。本人に、安全な方法で渡してください。' }),
  el('dl', { class: 'facts' },
    el('dt', { text: 'ログイン ID' }), el('dd', { text: res.loginId }),
    el('dt', { text: '仮のパスワード' }), el('dd', {}, noTranslate(el('div', { class: 'secret', text: res.initialPassword }))),
    el('dt', { text: '認証アプリの鍵' }), el('dd', {}, noTranslate(el('div', { class: 'secret', text: res.totpSecret })))),
  qrImg(res.qrSvg),
  el('p', { class: 'note', text: '認証アプリで読み取ってください' }),
  el('div', { class: 'actions' }, closeBtn('渡したので閉じる')));
const post = async (url, body) => { const r = await api('POST', url, body); if (!r.ok) alertLine(r.message); show(current); return r; };
/** 入力を1つ（または2つ）聞いてから実行する */
function askForm(title, note, fields, run, okText = '実行する') {
  const form = el('form', { class: 'form', novalidate: true }, note && el('p', { text: note }), fields, msgLine(),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: okText }), closeBtn('やめる')));
  onSubmit(form, async (data) => { const res = await run(data); if (res.ok) { dlg.close(); show(current); } return res; });
  openDialog(title, form);
}
async function billingPanel() {
  const res = await api('GET', withLimit('/api/billing/lines', 'lines'));
  if (!res.ok) return [el('p', { class: 'msg', text: res.message })];
  const picked = new Set();
  const settleBtn = smallBtn('選んだ明細を、当日現金で精算', async () => {
    const r = await api('POST', '/api/billing/settle', { lineIds: [...picked] });
    if (!r.ok) return alertLine(r.message);
    show('billing');
    openDialog('精算しました', el('p', { text: `請求書（領収書を兼ねる）${r.invoice.number} を発行しました。金額 ${yen(r.invoice.total)}` }),
      el('div', { class: 'actions' }, el('a', { class: 'btn btn-primary', href: `/api/billing/invoices/${r.invoice.id}/pdf`, text: 'PDF を開く' }), closeBtn()));
  }, 'btn-primary');
  // 押せない大きなボタンを先に見せない。明細を選ぶと「○件を当日現金で精算」が出る
  settleBtn.hidden = true;
  const syncSettle = () => { settleBtn.hidden = picked.size === 0; settleBtn.textContent = `${picked.size}件を、当日現金で精算`; };
  const rows = res.lines.map((l) => {
    const box = l.state === 'unsettled' && el('input', { type: 'checkbox', 'aria-label': `${l.label} を精算に選ぶ`, onchange: (ev) => { if (ev.target.checked) picked.add(l.id); else picked.delete(l.id); syncSettle(); } });
    const a = isAdmin();
    return el('tr', {},
      el('td', {}, box || ''),
      el('td', { class: 'n paddle', text: l.paddle ?? '' }),
      el('td', { class: 'dyn' }, l.name, el('div', { class: 'note', text: l.label })),
      // 払う金額は、落札額＋買歩銭
      el('td', { class: 'n' }, yen(l.payable), l.premium ? el('div', { class: 'note', text: `落札 ${yen(l.amount)}＋買歩銭 ${yen(l.premium)}` }) : null),
      el('td', { text: `${RECV[l.receive] ?? ''}${l.payment ? '・' + PAY[l.payment] : ''}` }),
      el('td', {}, el('span', { class: l.state === 'unpaid' ? 'warn' : 'state', 'data-on': ['cleared', 'delivered'].includes(l.state) ? '1' : '0', text: LINE_STATE[l.state] }),
        l.invoice && el('div', { class: 'note', text: `${l.invoice.number}${l.invoice.dueDate ? '　期限 ' + jpDay(l.invoice.dueDate) : ''}` }),
        l.pickupBy && l.state === 'cleared' && el('div', { class: l.pickupLate ? 'warn' : 'note', text: `受け取り期限 ${jpDay(l.pickupBy)}` }),
        l.offer && el('div', { class: 'note', text: `繰り上げ: ${{ open: '回答待ち', accepted: '承諾', declined: '辞退', expired: '期限切れ' }[l.offer.state]}` })),
      act(
        // 消し込み: 入金の日と方法（振込・現金）を入れる。受付係は、現金の受け取りだけ（本番運用の評価 C）
        ['billed', 'unpaid'].includes(l.state) && smallBtn(a ? '入金を記録' : '現金を受け取った', () => askForm(a ? '入金の記録（消し込み）' : '現金の受け取り', `${l.name}　${l.label}。受け取った金額が、明細の金額（${yen(l.payable)}${l.premium ? '。買歩銭を含む' : ''}）と一致するときだけ記録できます。`,
          [field('受け取った金額（円）', 'amount', { inputMode: 'numeric', required: true }),
            field('入金の日', 'paidOn', { type: 'date', value: todayStr(), max: todayStr(), required: true }, '振込なら、通帳・明細に載っている日'),
            a ? field('方法', 'method', { options: [['transfer', '銀行振込'], ['cash', '現金']] }) : null,
            field('メモ', 'memo', {}, '任意')].filter(Boolean),
          (d) => api('POST', `/api/billing/lines/${l.id}/clear`, { amount: Number(d.amount), paidOn: d.paidOn, method: a ? d.method : 'cash', memo: d.memo }), '記録する'), 'btn-primary'),
        a && l.state === 'unpaid' && smallBtn('督促', () => askForm('督促の記録', l.dunning.map((d) => `${dateFmt.format(d.at)} ${d.method}: ${d.body}`).join('\n'),
          [field('方法', 'method', { required: true, placeholder: '電話・メールなど' }), field('内容', 'body', { rows: 3, required: true })], (d) => api('POST', `/api/billing/lines/${l.id}/dun`, d), '記録する')),
        a && l.state === 'unpaid' && smallBtn('解除…', () => askReason('落札を解除', '解除の理由', true, (reason) => api('POST', `/api/billing/lines/${l.id}/cancel`, { reason }), '解除する'), 'btn-danger'),
        l.state === 'cleared' && l.kind !== 'penalty' && l.kind !== 'late' && smallBtn('引き渡し', () => confirmDo(`${l.name}さんに引き渡しますか？`, `${l.label}。引き渡しの記録を残します（取り消しは主催者管理者だけができます）。`, '引き渡す', () => api('POST', `/api/billing/lines/${l.id}/deliver`)), 'btn-primary'),
        a && l.state === 'cleared' && smallBtn('消し込みを取り消す', () => askReason('消し込みを取り消す', '取り消しの理由', true, (reason) => api('POST', `/api/billing/lines/${l.id}/unclear`, { reason }), '取り消す')),
        a && l.state === 'delivered' && smallBtn('引き渡しを取り消す', () => askReason('引き渡しの記録を取り消す', '取り消しの理由', true, (reason) => api('POST', `/api/billing/lines/${l.id}/undeliver`, { reason }), '取り消す')),
        a && l.state === 'cancelled' && l.kind === 'lot' && !l.offer && smallBtn('繰り上げを打診', () => confirmDo('次点の人に、繰り上げを打診しますか？', `${l.label}。次点の人に、繰り上げ落札のご案内をメールで送ります（回答の期限は3日後）。打診できるのは1人だけで、取り消せません。`, '打診する', () => api('POST', `/api/billing/lines/${l.id}/offer`))),
        a && ['lot', 'promote'].includes(l.kind) && l.receive === 'ship' && l.state !== 'cancelled' && smallBtn('送料', () => shippingForm(l.accountId, l.eventId, l.name)),
        // 違約金・遅延損害金: 設定の率から計算した案を初めに入れておく。金額は、確かめてから確定する
        ...(a && l.state === 'cancelled' || a && ['cleared', 'delivered'].includes(l.state) && l.invoice?.dueDate && l.clearedOn > l.invoice.dueDate ? [l.state === 'cancelled' ? ['penalty', '違約金'] : ['late', '遅延損害金']].map(([kind, name]) => smallBtn(name, async () => {
          const hint = await api('GET', `/api/billing/lines/${l.id}/penalty-suggest?kind=${kind}`);
          askForm(`${name}の請求`, `金額を確かめて、確定してください。別の請求書を発行します。${hint.basis ? `（${hint.basis}）` : ''}`,
            [field('金額（円）', 'amount', { inputMode: 'numeric', required: true, value: hint.amount ?? '' })], (d) => api('POST', `/api/billing/lines/${l.id}/penalty`, { kind, amount: Number(d.amount) }), '請求書を発行');
        })) : []),
        a && ['cancelled', 'cleared', 'delivered'].includes(l.state) && smallBtn('返金', () => askForm('返金の記録', `${l.name}　${l.label}`,
          [field('返金額（円）', 'amount', { inputMode: 'numeric', required: true }), field('返金日', 'date', { type: 'date', value: res.today, required: true }),
            field('方法', 'method', { options: [['transfer', '振込'], ['cash', '現金']] }), field('理由', 'reason', { rows: 2, required: true })], (d) => api('POST', `/api/billing/lines/${l.id}/refund`, { ...d, amount: Number(d.amount) }), '記録する'))));
  });
  const nodes = [
    // 書き出しは、月に一度ほどの作業なので、ひとつの「書き出す」の中にまとめる（報告書 83 章）
    el('div', { class: 'toolbar' }, el('div', { class: 'toolbar__acts' }, settleBtn), isAdmin() && exportMenu([
      el('a', { class: 'btn', href: '/api/billing/shipping.csv', text: '配送の一覧（CSV）' }),
      el('a', { class: 'btn', href: `/api/billing/ledger.csv?month=${res.today.slice(0, 7)}`, text: '帳簿用の記録（CSV）' }),
      el('a', { class: 'btn', href: `/api/billing/invoices.xlsx?month=${res.today.slice(0, 7)}`, text: '請求書の一覧（Excel）' })])),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    table(['', '参加番号', '落札者・品', '金額', '受け取り・支払', '状態', ''], rows, '落札した品は、まだありません。'),
    moreBtn('lines', res, '落札の明細'),
  ];
  if (isAdmin()) {
    const inv = await api('GET', withLimit('/api/billing/invoices', 'invoices'));
    nodes.push(el('h2', { class: 'subhead', text: '請求書' }),
      table(['請求番号', '宛先', '種類', '金額', '発行日', '送付・期限', ''], inv.invoices.map((i) => el('tr', {},
        el('td', { class: 'n', text: i.number }), el('td', { class: 'dyn', text: i.name }), el('td', { text: INV_KIND[i.kind] }), el('td', { class: 'n' }, i.cancelled ? [yen(i.total), el('br'), el('span', { class: 'note', text: `発行時 ${yen(i.issuedTotal)}・解除 ${i.cancelled}件` })] : yen(i.total)), el('td', { class: 'n', text: jpDay(i.issuedOn) }),
        el('td', {}, i.kind === 'cash' ? 'その場で渡した' : el('span', { class: !i.sentOn && i.stale ? 'warn' : '', text: `${i.sentOn ? `送付 ${jpDay(i.sentOn)}` : i.draft === 'failed' ? '未送付（下書きの作成に失敗）' : '未送付'}　期限 ${jpDay(i.dueDate)}` })),
        act(el('a', { class: 'btn', href: `/api/billing/invoices/${i.id}/pdf`, text: 'PDF' }), el('a', { class: 'btn', href: `/api/billing/invoices/${i.id}/xlsx`, text: 'Excel' }),
          !['cash', 'penalty'].includes(i.kind) && !i.sentOn && smallBtn(i.shipping ? `送料 ${yen(i.shipping.amount)}` : '送料を入力', () => shippingForm(i.accountId, i.eventId, i.name, i.shipping)),
          i.kind !== 'cash' && (i.sentOn ? smallBtn('送付を取り消す', () => post(`/api/billing/invoices/${i.id}/unsent`)) : smallBtn('送付済みにする', () => post(`/api/billing/invoices/${i.id}/sent`), 'btn-primary'))))), '請求書は、まだありません。'),
      moreBtn('invoices', inv, '請求書の一覧'));
  }
  return nodes;
}
async function pickupPanel() {
  const res = await api('GET', '/api/billing/pickup');
  return [table(['落札者', '品', '消し込み', '受け取り期限'], res.lines.map((l) => el('tr', {},
      el('td', { class: 'dyn', text: l.name }), el('td', { class: 'dyn', text: l.label }), el('td', { class: 'n', text: jpDay(l.clearedOn) }),
      el('td', {}, el('span', { class: l.pickupLate ? 'warn' : 'n', text: `${jpDay(l.pickupBy)}${l.pickupLate ? '（期限を過ぎています）' : ''}` })))), '未引き取りの品はありません。')];
}
let feeMonth = null;
async function feesPanel() {
  const [f, long] = await Promise.all([api('GET', '/api/billing/fees' + (feeMonth ? `?month=${feeMonth}` : '')), api('GET', '/api/billing/long-unpaid')]);
  feeMonth = f.month;
  const pick = el('input', { class: 'input', type: 'month', value: f.month, 'aria-label': '月', onchange: (ev) => { feeMonth = ev.target.value; show('fees'); } });
  return [
    el('div', { class: 'toolbar' }, el('div', { class: 'monthpick' }, pick),
      f.confirmedOn ? el('p', { text: `確認済み（${jpDay(f.confirmedOn)}）` }) : isAdmin() && smallBtn('この月の明細を、確認済みにする', () => confirmDo(`${f.month.slice(0, 4)}年${Number(f.month.slice(5))}月の明細を、確認済みにしますか？`, '確認済みにすると、取り消せません。金額を確かめてから押してください。', '確認済みにする', () => api('POST', '/api/billing/fees/confirm', { month: f.month })), 'btn-primary')),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    el('dl', { class: 'facts' },
      el('dt', { text: '対象の落札額（消し込み済み・税込）' }), el('dd', { class: 'n', text: yen(f.base) }),
      el('dt', { text: `手数料（${f.rate}%。差し引き ${yen(f.deduction)}）` }), el('dd', { class: 'n', text: yen(f.fee) }),
      el('dt', { text: '最低保証額' }), el('dd', { class: 'n', text: yen(f.minimum) }),
      el('dt', { text: `消費税（${f.taxMode === 'exclusive' ? '外税' : '内税'}）` }), el('dd', { class: 'n', text: f.taxMode === 'exclusive' ? yen(f.tax) : '手数料に含む' }),
      el('dt', { text: '請求額' }), el('dd', { class: 'n paddle', text: yen(f.total) })),
    el('h2', { class: 'subhead', text: '根拠になる明細' }),
    table(['品', '税込落札額', '支払方法', '消し込みの日', '返金・取り消し'], f.details.map((d) => el('tr', {},
      el('td', { class: 'dyn', text: d.label }), el('td', { class: 'n', text: yen(Math.abs(d.amount)).replace('¥', d.amount < 0 ? '−¥' : '¥') }), el('td', { text: d.method ?? '' }), el('td', { class: 'n', text: jpDay(d.clearedOn) }), el('td', { text: d.note }))), 'この月の明細はありません。'),
    el('h2', { class: 'subhead', text: '長く未払いのままの明細（期限の翌日から30日以上）' }),
    table(['落札者', '品', '金額', '期限', '督促', '引き渡し'], long.lines.map((l) => el('tr', {},
      el('td', { class: 'dyn', text: l.name }), el('td', { class: 'dyn', text: l.label }), el('td', { class: 'n', text: yen(l.amount) }), el('td', { class: 'n', text: jpDay(l.invoice.dueDate) }),
      el('td', { text: `${l.dunning.length} 回` }), el('td', { text: l.deliveredOn ? '済' : '未' }))), '該当する明細はありません。'),
  ];
}


// ------------------------------------------------------------ スタッフ
// メールアドレスを登録した（または、パスワードを決め直せるようにした）あとの知らせ
function inviteDialog(title, res) {
  openDialog(title,
    el('p', { class: 'dyn', text: `${res.email} を登録しました。本人に、スタッフのログインの画面の「はじめての方」から、このメールアドレスを入れて、パスワードを決めるよう、お伝えください。` }),
    el('div', { class: 'actions' }, closeBtn('閉じる')));
}
async function staffPanel() {
  const res = await api('GET', '/api/staff/accounts');
  const rows = res.staff.map((s) => el('tr', {},
    el('td', { class: 'dyn', text: s.email ?? `${s.loginId}（ログイン ID）` }), el('td', { class: 'dyn', text: s.name }), el('td', { text: s.roleLabel }),
    el('td', { text: !s.active ? '停止' : s.ready ? '利用中' : 'パスワードの登録待ち' }),
    act(s.active && smallBtn(s.email ? 'パスワードの再設定' : '再発行', () => confirmDo(
        s.email ? `${s.name}さんのパスワードを消しますか？` : `${s.name}さんのパスワードと認証アプリを再発行しますか？`,
        s.email ? `いまのパスワードは使えなくなり、ログイン中の画面もすべて切れます。${s.email} に、パスワードを決め直す案内を送ります。` : 'いまのパスワードと認証アプリは使えなくなり、ログイン中の画面もすべて切れます。',
        s.email ? 'パスワードを消す' : '再発行する',
        () => api('POST', `/api/staff/accounts/${s.id}/reset`),
        { danger: true, then: async (r) => { await show('staff'); if (r.email) inviteDialog('パスワードを消しました', r); else secretsDialog('パスワードと認証アプリを再発行しました', r); } })),
      s.active && s.loginId !== me.loginId && smallBtn('停止', () => confirmDo(`${s.name}さんを停止しますか？`,
        'ログインできなくなり、ログイン中の画面もすべて切れます。あとから「停止を解く」で戻せます。', '停止する',
        () => api('POST', `/api/staff/accounts/${s.id}/stop`), { danger: true }), 'btn-danger'),
      !s.active && smallBtn('停止を解く', () => confirmDo(`${s.name}さんの停止を解きますか？`,
        '停止の前と同じパスワードで、またログインできるようになります。', '停止を解く',
        () => api('POST', `/api/staff/accounts/${s.id}/reactivate`)), 'btn-primary'))));
  return [
    el('div', { class: 'toolbar' }, el('span'), smallBtn('スタッフを登録', staffDialog, 'btn-primary')),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    table(['メールアドレス', '名前', '役割', '状態', ''], rows, ''),
  ];
}
function staffDialog() {
  const form = el('form', { class: 'form', novalidate: true },
    field('メールアドレス', 'email', { type: 'email', inputMode: 'email', required: true, autocapitalize: 'none', spellcheck: false }, 'このメールアドレスで、ログインします。パスワードは、本人が最初のログインで決めます'),
    field('名前', 'name', { required: true }),
    field('役割', 'role', { options: [['auctioneer', '進行役'], ['caller', 'オークショニア（競りの最中の開始値・うりきり・締め・流札だけ）'], ['reception', '受付係'], ['admin', '主催者管理者'], ['operator', '開発・運営者（手数料と記録を見るだけ）']] }),
    field('電話番号', 'phone', { type: 'tel', inputMode: 'tel' }, '任意。この番号では会員登録できなくなります'),
    msgLine(),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '作る' }), closeBtn()));
  onSubmit(form, async (data) => {
    const res = await api('POST', '/api/staff/accounts', data);
    if (res.ok) {
      await show('staff');
      inviteDialog('スタッフのメールアドレスを登録しました', res);
    }
    return res;
  });
  openDialog('スタッフのメールアドレスを登録', form);
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
// 印鑑の画像の登録。画像は、サーバーのデータの置き場にだけ保存する
function sealBox(fixed = false) {
  const preview = el('img', { class: 'seal', alt: '登録してある印鑑', width: 96, height: 96, hidden: true });
  const note = el('p', { class: 'note', text: '登録されていません。' });
  // 「登録を消す」は、登録してあるときだけ出す（報告書 83 章）
  const refresh = () => { preview.onload = () => { preview.hidden = false; note.textContent = '登録済みです。'; const d = $('#sealDelete'); if (d) d.hidden = false; }; preview.onerror = () => { preview.hidden = true; note.textContent = '登録されていません。'; const d = $('#sealDelete'); if (d) d.hidden = true; }; preview.src = `/api/settings/seal?${Date.now()}`; };
  const input = el('input', { type: 'file', accept: 'image/png,image/jpeg', class: 'sr-only', id: 'sealInput' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { note.textContent = '画像は、2MB までにしてください。'; return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const res = await api('POST', '/api/settings/seal', { image: btoa(bin) });
    if (res.ok) refresh(); else note.textContent = res.message;
  });
  refresh();
  // 原本の印鑑で固定しているときは、ここでは変えられない（配るときの設定で変える）
  if (fixed) { preview.onload = () => { preview.hidden = false; note.textContent = '原本の印鑑を押します（配るときの設定で固定しています）。'; }; return el('div', { class: 'sealbox' }, preview, el('div', {}, note)); }
  return el('div', { class: 'sealbox' }, preview, el('div', {}, note, input, el('label', { class: 'btn', htmlFor: 'sealInput', text: '画像を選ぶ' }), ' ',
    el('button', { class: 'btn', type: 'button', id: 'sealDelete', hidden: true, text: '登録を消す', onclick: () => confirmDo('印鑑の画像を消しますか？', 'これから出す請求書には、印鑑が押されなくなります。', '消す',
      () => api('POST', '/api/settings/seal', { image: null }), { danger: true, then: async () => refresh() }) })));
}
// 規約類（利用規約・特定商取引法に基づく表示・プライバシーポリシー）の文面
async function legalBox() {
  const res = await api('GET', '/api/legal');
  const form = el('form', { class: 'form', novalidate: true },
    field('利用規約', 'terms', { value: res.docs.terms.body, rows: 8 }),
    field('特定商取引法に基づく表示', 'tokushoho', { value: res.docs.tokushoho.body, rows: 8 }),
    field('プライバシーポリシー', 'privacy', { value: res.docs.privacy.body, rows: 8 }),
    el('p', { class: 'msg', role: 'alert', tabIndex: -1 }),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '規約類を保存する' })));
  onSubmit(form, async (data) => {
    const r = await api('POST', '/api/settings/legal', data);
    if (r.ok) { releaseWarning(); unsaved = false; }
    if (r.ok) { const m = $('.msg', form); m.classList.add('ok'); m.textContent = '保存しました'; return null; }
    return r;
  });
  return el('div', {}, el('h2', { class: 'subhead', text: '規約類' }), form);
}
async function settingsPanel() {
  const s = await api('GET', '/api/settings');
  const form = el('form', { class: 'form', novalidate: true },
    field('主催者の名称', 'orgName', { value: s.orgName, required: true }),
    field('古物商の許可', 'kobutsuLicense', { value: s.kobutsuLicense, placeholder: '〇〇県公安委員会　第000000000000号' }, '許可をした公安委員会の名称と、許可証の番号。主催者の名称と一緒に、サイトの下と競りの画面に出します（古物営業法）'),
    field('返品特約の表示', 'returnPolicy', { value: s.returnPolicy, rows: 4, required: true }, 'トップページに表示します。弁護士の確認が済むまでは仮の文言です'),
    field('送料の表示', 'shippingNotice', { value: s.shippingNotice, rows: 3, required: true }, 'トップページに表示します'),
    el('h2', { class: 'subhead', text: '請求書に載せる内容' }),
    field('住所', 'orgAddress', { value: s.orgAddress, rows: 2 }, '郵便番号から。改行できます'),
    el('div', { class: 'grid2' }, field('電話番号', 'orgTel', { value: s.orgTel, type: 'tel', inputMode: 'tel' }), field('メールアドレス', 'orgEmail', { value: s.orgEmail, type: 'email', spellcheck: false })),
    field('適格請求書発行事業者の登録番号', 'invoiceRegNo', { value: s.invoiceRegNo }, 'T から始まる番号'),
    field('振込先の口座', 'bankAccount', { value: s.bankAccount }),
    el('h2', { class: 'subhead', text: '印鑑（請求書に押す）' }),
    sealBox(!!s.sealFixed),
    el('h2', { class: 'subhead', text: '買歩銭' }),
    field('買歩銭の割合（%）', 'buyerPremiumRate', { value: s.buyerPremiumRate, inputMode: 'numeric' }, '落札者が、落札額に上乗せして払う手数料。変えても、すでに落札した品の金額は変わりません'),
    // 契約で一度決めれば変えない項目は、畳んでおく（ふだんの設定の画面を短くする。報告書 83 章）
    el('details', { class: 'fold' }, el('summary', { text: '契約で決める項目（違約金・遅延損害金・手数料）' }),
    el('h2', { class: 'subhead', text: '違約金・遅延損害金' }),
    el('div', { class: 'grid2' },
      field('解除の違約金（法人。落札額の %）', 'penaltyRateB2b', { value: s.penaltyRateB2b, inputMode: 'decimal' }),
      field('解除の違約金（個人。落札額の %）', 'penaltyRateB2c', { value: s.penaltyRateB2c, inputMode: 'decimal' }),
      field('遅延損害金（法人。年率 %）', 'lateRateB2b', { value: s.lateRateB2b, inputMode: 'decimal' }),
      field('遅延損害金（個人。年率 %）', 'lateRateB2c', { value: s.lateRateB2c, inputMode: 'decimal' })),
    el('h2', { class: 'subhead', text: '手数料の集計' }),
    el('div', { class: 'grid2' },
      field('消費税の扱い', 'feeTaxMode', { options: [['exclusive', '外税（手数料に消費税を足す）'], ['inclusive', '内税（手数料に含む）']], value: s.feeTaxMode || 'exclusive' }),
      field('最低保証額（円）', 'feeMinimum', { value: s.feeMinimum, inputMode: 'numeric' }, '未定なら空のまま'))),
    el('p', { class: 'msg', role: 'alert', tabIndex: -1 }),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '保存する' })));
  for (const name of s.fixed ?? []) { const input = form.elements[name]; if (input) { input.readOnly = true; input.setAttribute('aria-readonly', 'true'); } }
  onSubmit(form, async (data) => {
    const res = await api('POST', '/api/settings', data);
    if (res.ok) { releaseWarning(); unsaved = false; }
    if (res.ok) { const m = $('.msg', form); m.classList.add('ok'); m.textContent = '保存しました'; return null; }
    return res;
  });
  return [el('div', { class: 'narrowcol' }, el('div', { class: 'missing', id: 'missingList', hidden: true }), form, await legalBox())];
}

// ------------------------------------------------------------ 記録（監査ログ・知らせ）
// 記録の「操作」を、読める言葉にする（無いものは、そのまま出す）
const AUDIT_TEXT = {
  'member.login': '会員がログイン', 'view.members': '会員の一覧を表示', 'view.invoice': '請求書のファイルを表示', 'billing.invoices_export': '請求書の一覧を書き出し',
  'stream.start': '配信を開始', 'stream.stop': '配信を停止', 'stream.camera': 'カメラを切り替え', 'comment.hide': 'コメントを消した', 'privacy.purge': '保存期間を過ぎた個人情報を削除',
  'staff.login': 'スタッフがログイン', 'staff.create': 'スタッフを登録', 'staff.reset': 'スタッフのパスワードを再発行', 'staff.stop': 'スタッフを停止', 'staff.setup': 'スタッフがパスワードを決めた', 'staff.locked': 'スタッフのログインを一時停止（失敗が続いたため）', 'event.running': '開催を進行中にした', 'event.break': '休憩に入った', 'event.ended': '開催を終了', 'staff.reactivate': 'スタッフの停止を解除', 'staff.password_change': 'スタッフがパスワードを変更',
  'member.register': '会員登録', 'member.approve': '会員登録を承認', 'member.reject': '会員登録を承認しない', 'member.credentials_issue': 'ログイン情報を発行', 'member.credentials': '会員がパスワードを変更', 'member.update': '会員が登録内容を変更', 'member.withdraw': '会員が退会', 'member.suspend': '会員を停止', 'member.unsuspend': '会員の停止を解除', 'member.phone_change': '会員の電話番号を変更',
  'event.create': '開催を登録', 'event.update': '開催を変更', 'event.publish': '開催を公開', 'event.join': '参加手続き', 'participation.change': '参加の内容を変更',
  'lot.create': '品を登録', 'proxy.bid': '代理で入札', 'proxy.cancel': '代理の入札を取り消し',
  'reception.checkin': '来場を確認', 'reception.join': '参加手続きを代行',
  'billing.settle': '当日現金で精算', 'billing.clear': '入金を消し込み', 'billing.unclear': '消し込みを取り消し', 'billing.deliver': '引き渡し', 'billing.undeliver': '引き渡しを取り消し',
  'billing.cancel': '落札を解除', 'billing.penalty': '違約金を請求', 'billing.refund': '返金', 'billing.offer': '繰り上げを案内', 'billing.dun': '督促', 'billing.memo': 'メモを変更', 'billing.receive': '受け取り方法を変更',
  'billing.shipping': '送料を入力', 'billing.shipping_export': '配送の一覧を書き出し', 'billing.ledger_export': '帳簿用の記録を書き出し',
  'invoice.issue_on_end': '請求書を発行', 'invoice.sent': '請求書を送付済みに', 'invoice.unsent': '送付済みを取り消し', 'offer.accept': '繰り上げを承諾', 'offer.decline': '繰り上げを辞退',
  'fee.confirm': '手数料の明細を確認', 'settings.update': '設定を変更', 'event.mail': '開催のお知らせメールを送信', 'member.event_mail': '開催のお知らせメールの受け取りを変更', 'settings.legal': '規約を変更', 'settings.seal': '印鑑の画像を変更', 'sms.limit_reset': 'SMS の制限を解除',
};
// 記録の「前」「後」（機械向けの形）を、読める言葉にする
const AUDIT_KEY = { mode: '参加', payment: '支払', receive: '受け取り', checkedIn: '来場確認', paddle: '参加番号', kind: '区分', fields: '変えた項目', loginId: 'ログイン ID', role: '役割', by: '登録元', amount: '金額', title: '名前', status: '状態', reason: '理由', memo: 'メモ', shipping: '送料', dueDate: '期限', number: '請求番号' };
const AUDIT_VALUE = { venue: '会場', online: 'オンライン', cash: '当日現金', transfer: '銀行振込', pickup: '現地受け取り', ship: '配送', b2c: '個人', b2b: '法人', true: 'はい', false: 'いいえ', admin: '主催者管理者', auctioneer: '進行役', caller: 'オークショニア', reception: '受付係', operator: '開発運営者' };
// 記録の「対象」を、読める形にする（member:12 → 会員 12。報告書 81 章）
const TARGET_KIND = { member: '会員', staff: 'スタッフ', event: '開催', lot: '品', line: '明細', offer: '繰り上げ', participant: '参加者', invoice: '請求書', account: '会員' };
const targetText = (t) => String(t ?? '').replace(/\b([a-z]+):(\d+)\b/g, (m, k, id) => (TARGET_KIND[k] ? `${TARGET_KIND[k]} ${id}` : m));
function auditText(raw) {
  if (!raw) return '';
  let v;
  try { v = JSON.parse(raw); } catch { return raw; }
  if (v === null || typeof v !== 'object') return String(v);
  const show = (x) => (Array.isArray(x) ? x.map(show).join('・') : x !== null && typeof x === 'object' ? JSON.stringify(x) : AUDIT_VALUE[String(x)] ?? String(x));
  return Object.entries(v).map(([k, x]) => `${AUDIT_KEY[k] ?? k}: ${show(x)}`).join('、');
}
async function auditPanel() {
  const [audit, notices] = await Promise.all([api('GET', '/api/audit'), api('GET', '/api/notices')]);
  // 誰が: スタッフは名前で（主催者管理者のときだけ、一覧から引ける）
  const staffNames = me.role === 'admin' ? new Map(((await api('GET', '/api/staff/accounts')).staff ?? []).map((x) => [x.id, x.name])) : new Map();
  const who = (e) => (e.actor_kind === 'staff' ? staffNames.get(e.actor_id) ?? `スタッフ ${e.actor_id}` : e.actor_kind === 'member' ? `会員 ${e.actor_id}` : e.actor_kind === 'system' ? 'システム' : '');
  // 変わる前と後の値は、ふだんは見ないので、「内容」を押したときだけ出す（列を3つ減らす。報告書 83 章）
  const detail = (e) => {
    const before = auditText(e.before), after = auditText(e.after);
    if (!before && !after && !e.reason) return '';
    return el('details', { class: 'auditdetail' }, el('summary', { text: e.reason ? `理由: ${e.reason}` : '内容' }),
      before && el('p', { text: `前: ${before}` }), after && el('p', { text: `後: ${after}` }));
  };
  return [
    (notices.notices ?? []).length ? el('div', { class: 'banner', role: 'alert' }, el('span', { text: `送信に失敗した知らせが ${notices.notices.length} 件あります（SMS・メール）。` })) : null,
    table(['日時', '操作', '誰が', '対象', ''], audit.entries.map((e) => el('tr', {},
      el('td', { class: 'n', text: dateFmt.format(e.at) }), el('td', { text: AUDIT_TEXT[e.type] ?? e.type }), el('td', { class: 'dyn', text: who(e) }), el('td', { text: targetText(e.target) }),
      el('td', { class: 'dyn' }, detail(e)))), '記録はまだありません。'),
  ];
}

// ------------------------------------------------------------ 切り替え
const PANELS = {
  reception: ['受付', receptionPanel, ['admin', 'auctioneer', 'reception']],
  billing: ['請求', billingPanel, ['admin', 'reception']],
  pickup: ['未引き取り', pickupPanel, ['admin', 'auctioneer', 'reception']],
  events: ['開催', eventsPanel, ['admin']],
  members: ['会員', membersPanel, ['admin']],
  staff: ['スタッフ', staffPanel, ['admin']],
  settings: ['設定', settingsPanel, ['admin']],
  fees: ['手数料', feesPanel, ['admin', 'operator']],
  audit: ['記録', auditPanel, ['admin', 'operator']],
};
async function show(key) {
  current = key;
  unsaved = false; // パネルを描き直すと、書きかけの欄はなくなる
  // 開いているタブを URL に載せる（読み込み直しても、同じタブに戻る。URL を人に渡せる）
  if (location.hash.slice(1) !== key) history.replaceState(null, '', `#${key}`);
  for (const b of $('#tabs').children) { b.setAttribute('aria-selected', String(b.dataset.key === key)); b.tabIndex = b.dataset.key === key ? 0 : -1; }
  // 読み込みのあいだは、前のタブの中身を薄くして、読み込み中だと分かるようにする（報告書 82 章）
  panel.setAttribute('aria-busy', 'true');
  const nodes = await PANELS[key][1]();
  if (current !== key) return;
  panel.removeAttribute('aria-busy');
  panel.replaceChildren(...nodes.filter(Boolean));
  if (key === 'settings') renderMissing();
  // ダイアログで実行すると、開いたボタンは描き直しで消える。フォーカスが行き場を失ったら、パネルへ戻す（報告書 81 章）
  if (!document.activeElement || document.activeElement === document.body) panel.focus({ preventScroll: true });
  panel.setAttribute('aria-labelledby', `tab-${key}`);
  if (pendingNotice) { const line = $('#line'); if (line) line.textContent = pendingNotice; pendingNotice = null; }
}

// ログインのあとの行き先（進行コンソール・会場モニターから来た人は、そこへ戻す）
// オークショニアは、オークショニアの画面だけを使う
const afterLogin = (role) => { location.href = role === 'caller' || (toCaller && role === 'admin') ? '/caller.html' : toMonitor ? '/monitor.html' : toConsole && ['admin', 'auctioneer'].includes(role) ? '/console.html' : '/staff.html'; };
onSubmit($('#loginForm'), async (data) => {
  const res = await api('POST', '/api/staff/login', { email: data.email, password: data.password });
  if (res.ok) afterLogin(res.staff.role);
  else $('#loginForm').elements.password.value = '';
  return res;
});
// はじめての方: 登録されたメールアドレスを入れて、パスワードを自分で決める
onSubmit($('#setupForm'), async (data) => {
  if (data.password !== data.password2) return { ok: false, message: '入力を確かめてください', errors: { password2: '新しいパスワードが、2つの欄で違っています' } };
  const res = await api('POST', '/api/staff/setup', { email: data.email, password: data.password });
  if (res.ok) afterLogin(res.staff.role);
  return res;
});
$('#firstTime').addEventListener('click', () => { $('#loginForm').hidden = true; $('#setupForm').hidden = false; $('#setupForm').elements.email.value = $('#loginForm').elements.email.value; $('#setupForm').elements.email.focus(); });
$('#backToLogin').addEventListener('click', () => { $('#setupForm').hidden = true; $('#loginForm').hidden = false; $('#loginForm').elements.email.focus(); });
(async () => {
  const state = await setupNav();
  me = state.staff;
  if (!me) { $('#login').hidden = false; $('#loginForm').elements.email.focus(); return; }
  if (me.role === 'caller') { location.replace('/caller.html'); return; }
  // 「公開の前に入れておく項目」の帯は、画面を出す前に用意する（出したあとに差し込むと、中身が下にずれる。
  // Safari では、ずれる途中の描き直しが残り、帯が切れて見えた。報告書 98 章）
  if (me.role === 'admin') await releaseWarning();
  $('#app').hidden = false;
  $('#who').textContent = `${me.name}・${me.roleLabel}`;
  $('#myPassword').addEventListener('click', passwordDialog);
  // 競りの進行は、主催者管理者と進行役（8.14）
  $('#toConsole').hidden = !['admin', 'auctioneer'].includes(me.role);
  $('#toCaller').hidden = me.role !== 'admin';
  $('#toMonitor').hidden = me.role === 'operator'; // 会場の大型モニターは、会場にいるスタッフが開く
  const keys = Object.keys(PANELS).filter((k) => PANELS[k][2].includes(me.role));
  $('#tabs').replaceChildren(...keys.map((k) => el('button', { type: 'button', role: 'tab', id: `tab-${k}`, 'aria-controls': 'panel', 'data-key': k, text: PANELS[k][0], onclick: () => leavePanel(() => { pendingNotice = null; show(k); }) })));
  show(keys.includes(location.hash.slice(1)) ? location.hash.slice(1) : keys[0]);
})();

// 正式に公開する前に、埋めておくべきもの（規約類・返品特約の仮の文言・振込先）。主催者管理者に、上に出し続ける（報告書 80 章）
async function releaseWarning() {
  const [legal, settings] = await Promise.all([api('GET', '/api/legal'), api('GET', '/api/settings')]);
  if (!legal.ok || !settings.ok) return;
  const missing = [
    !legal.docs.terms.body && '利用規約', !legal.docs.privacy.body && 'プライバシーポリシー', !legal.docs.tokushoho.body && '特定商取引法に基づく表示',
    /【仮/.test(settings.returnPolicy ?? '') && '返品特約（仮の文言のまま）', !settings.bankAccount && '振込先', !settings.kobutsuLicense && '古物商の許可の表示',
  ].filter(Boolean);
  S_missing = missing; renderMissing();
  const text = `公開の前に、入れておく項目が ${missing.length} つあります`;
  const now = $('#releaseWarn');
  if (!missing.length) { now?.remove(); return; }
  // すでに出ていれば、数だけを書き換える（消して入れ直さない。描き直しで帯がちらつかないように）
  if (now) { now.querySelector('.notice__text').textContent = text; return; }
  // 1行だけ: 何件あるかと、直す場所への入口。中身は「設定」の上に出す（どのタブにも大きな赤字を出さない。報告書 83 章）
  $('#app').prepend(el('div', { class: 'notice', id: 'releaseWarn', role: 'status' }, el('span', { class: 'notice__icon', 'aria-hidden': 'true' }),
    el('span', { class: 'notice__text', text }),
    el('button', { class: 'textbtn', type: 'button', text: '設定を開く', onclick: () => leavePanel(() => { pendingNotice = null; show('settings'); }) })));
}
/** 「設定」の上に、まだ入っていない項目を並べる */
function renderMissing() {
  const box = $('#missingList'); if (!box) return;
  box.hidden = !S_missing.length;
  box.replaceChildren(el('b', { text: '公開の前に入れておく項目' }), el('ul', {}, S_missing.map((m) => el('li', { text: m }))));
}
tabKeys($('#tabs'));
