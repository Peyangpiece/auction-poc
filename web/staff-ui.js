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
// 狭い画面では、表を、1件ずつのカードに並べ替える（報告書 129 章）。そのとき、値の左に出す見出しを、各マスに持たせる
function labelCells(heads, rows) {
  for (const tr of rows) [...(tr?.children ?? [])].forEach((td, i) => { if (td.colSpan === 1 && heads[i] && !td.dataset.label) td.dataset.label = heads[i]; });
  return rows;
}
function table(heads, rows, empty) {
  if (!rows.length) return el('p', { class: 'empty', text: empty });
  labelCells(heads, rows);
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
