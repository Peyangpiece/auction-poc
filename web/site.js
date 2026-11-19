// 会員・スタッフ用の画面の共通部品。
'use strict';

const yenFmt = new Intl.NumberFormat('ja-JP');
const yen = (n) => (n === null || n === undefined ? '' : '¥' + yenFmt.format(n));
const dateFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const $ = (sel, root = document) => root.querySelector(sel);
// 2026-11-23 → 11月23日（月）。年が今年でなければ、年も付ける
const jpDay = (d) => {
  if (!d) return '';
  const [y, m, dd] = d.slice(0, 10).split('-').map(Number);
  const w = '日月火水木金土'[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
  return `${y !== new Date().getFullYear() ? `${y}年` : ''}${m}月${dd}日（${w}）`;
};
// 携帯の 11 桁は 3-4-4 に区切る。それ以外は、そのまま
const telFmt = (p) => (/^0[5789]0\d{8}$/.test(p ?? '') ? `${p.slice(0, 3)}-${p.slice(3, 7)}-${p.slice(7)}` : p);

/** 要素を作る。文字は必ず textContent で入れる（入力された文字を HTML として解釈させない） */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node && k !== 'list' && k !== 'form') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

/** API を呼ぶ。返事は { ok, status, …本文 } */
async function api(method, url, body) {
  try {
    const isFile = body instanceof Blob;
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: method === 'POST' ? { 'content-type': isFile ? 'application/octet-stream' : 'application/json' } : {},
      body: method === 'POST' ? (isFile ? body : JSON.stringify(body ?? {})) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { ...json, ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0, message: 'サーバーにつながりません。通信の状態を確かめて、やり直してください' };
  }
}

/** フォームの送信。送っている間はボタンを止め、項目ごとの誤りをその欄の下に出す */
function onSubmit(form, handler) {
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const button = ev.submitter ?? $('button[type=submit]', form);
    const msg = $('.msg', form);
    if (msg) { msg.textContent = ''; msg.classList.remove('ok'); }
    for (const f of form.querySelectorAll('[aria-invalid]')) f.removeAttribute('aria-invalid');
    for (const e of form.querySelectorAll('.err')) e.textContent = '';
    // 送っている間は、ボタンを押せなくして、「送信中…」と出す（押せたのか分からない、を無くす。二重の送信も防ぐ）
    const label = button?.textContent;
    if (button) { button.disabled = true; button.textContent = '送信中…'; }
    const res = await handler(Object.fromEntries(new FormData(form)), button);
    if (button) { button.disabled = false; button.textContent = label; }
    if (res && !res.ok) {
      let first = null;
      for (const [name, text] of Object.entries(res.errors ?? {})) {
        const input = form.elements[name];
        const target = input instanceof RadioNodeList ? input[0] : input;
        if (!target) continue;
        target.setAttribute('aria-invalid', 'true');
        const err = target.closest('.field, fieldset, .check')?.querySelector('.err');
        if (err) err.textContent = text;
        first ??= target;
      }
      if (msg) msg.textContent = res.message ?? 'うまくいきませんでした。やり直してください';
      (first ?? msg)?.focus?.();
    }
  });
}

/** 入力欄を1つ作る */
function field(label, name, props = {}, hint = '') {
  const tag = props.rows ? 'textarea' : props.options ? 'select' : 'input';
  const { options, ...rest } = props;
  const input = el(tag, { class: 'input', name, ...rest }, (options ?? []).map(([value, text]) => el('option', { value, text })));
  if (props.value !== undefined && props.value !== null) input.value = props.value;
  // 説明の小さな文字は出さない（発注者の指示。報告書 78 章）。短い書き方の見本だけ、入力欄の中の薄い文字にする
  if (hint && !input.placeholder && !input.value && hint.length <= 24 && !/[。、]/.test(hint)) input.placeholder = hint;
  return el('label', { class: 'field' }, label, input, el('span', { class: 'err', role: 'alert' }));
}

const PREFECTURES = '北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県'.split(' ');

/** ラベルの横に付ける「必須」「任意」の印 */
const mark = (required) => el('span', { class: required ? 'req' : 'opt', text: required ? '必須' : '任意' });
/** ラベル・印・補足・入力欄・エラーをまとめた1欄 */
function labeled(label, required, input, hint = '') {
  if (hint && !input.placeholder && !input.value && hint.length <= 24 && !/[。、]/.test(hint)) input.placeholder = hint;
  return el('label', { class: 'field' }, el('span', { class: 'field__label' }, label, mark(required)), input, el('span', { class: 'err', role: 'alert' }));
}

/**
 * お名前・フリガナ・ご住所の入力欄（会員登録と、登録内容の変更で使う）。
 * 郵便番号を7桁入れると、都道府県と市区町村を自動で入れる。
 */
function personFields(m = {}) {
  const [last = '', first = ''] = String(m.name ?? '').split(/[\s　]+/);
  const [lastKana = '', firstKana = ''] = String(m.nameKana ?? '').split(/[\s　]+/);
  const input = (name, props) => el('input', { class: 'input', name, ...props });
  const zip = input('postalCode', { value: m.postalCode ?? '', inputMode: 'numeric', autocomplete: 'postal-code', maxLength: 8, required: true });
  const pref = el('select', { class: 'input', name: 'prefecture', autocomplete: 'address-level1', required: true },
    el('option', { value: '', text: '選んでください' }), PREFECTURES.map((p) => el('option', { value: p, text: p })));
  pref.value = m.prefecture ?? '';
  const a1 = input('address1', { value: m.address1 ?? (m.postalCode ? '' : m.address ?? ''), // 前の版で登録した人は、まとめて書いた住所をここに出す
    autocomplete: 'address-line1', required: true });
  const a2 = input('address2', { value: m.address2 ?? '', autocomplete: 'address-line2' });
  const zipNote = el('p', { class: 'note', role: 'status' });
  const picks = el('div', { class: 'picks' });
  let filled = ''; // 自動で入れた文字（利用者が書き足した分を、消さないため）
  const apply = (r) => {
    pref.value = r.prefecture;
    if (!a1.value || a1.value === filled) { a1.value = filled = r.city + r.town; }
    picks.replaceChildren();
    zipNote.textContent = '住所を入れました。続けて、番地を入力してください。';
    a1.focus(); a1.setSelectionRange(a1.value.length, a1.value.length);
  };
  let last7 = '';
  zip.addEventListener('input', async () => {
    const code = zip.value.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\D/g, '').slice(0, 7);
    zip.value = code.length > 3 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
    if (code.length !== 7 || code === last7) { if (code.length !== 7) last7 = ''; return; }
    last7 = code;
    zipNote.textContent = '住所を調べています…';
    const res = await api('GET', `/api/postal?code=${code}`);
    if (!res.ok || !res.results.length) { zipNote.textContent = 'この郵便番号の住所が見つかりませんでした。下の欄に、住所を入力してください。'; picks.replaceChildren(); return; }
    if (res.results.length === 1) return apply(res.results[0]);
    // 1つの郵便番号に町名がいくつもある場合は、選んでもらう
    zipNote.textContent = '町名を選んでください。';
    picks.replaceChildren(...res.results.map((r) => el('button', { class: 'btn', type: 'button', text: r.city + r.town, onclick: () => apply(r) })));
  });
  return [
    el('div', { class: 'pair' },
      labeled('姓', true, input('lastName', { value: last, autocomplete: 'family-name', required: true })),
      labeled('名', true, input('firstName', { value: first, autocomplete: 'given-name', required: true }))),
    el('div', { class: 'pair' },
      labeled('セイ', true, input('lastKana', { value: lastKana, autocomplete: 'off', required: true })),
      labeled('メイ', true, input('firstKana', { value: firstKana, autocomplete: 'off', required: true }))),
    el('h2', { class: 'formhead', text: 'ご住所' }),
    labeled('郵便番号', true, zip, '7桁の数字。入れると、住所を自動で入れます'),
    zipNote, picks,
    labeled('都道府県', true, pref),
    labeled('市区町村・番地', true, a1),
    labeled('建物名・部屋番号', false, a2),
  ];
}

// 直した欄のエラーは、その場で消す（送り直すまで赤いまま、にしない）
for (const type of ['input', 'change']) document.addEventListener(type, (ev) => {
  const t = ev.target;
  if (!t.matches?.('[aria-invalid]')) return;
  t.removeAttribute('aria-invalid');
  const err = t.closest('.field, fieldset, .check')?.querySelector('.err');
  if (err) err.textContent = '';
});

// 認証番号（6桁）は、入れ終わったら、そのまま確かめに進む（もう一度ボタンを押す手間をなくす）。
// ほかの欄がまだ埋まっていないとき（スタッフのログインなど）は、進めない。
document.addEventListener('input', (ev) => {
  const input = ev.target;
  if (!(input instanceof HTMLInputElement) || !input.classList.contains('code') || !input.form) return;
  input.value = input.value.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\D/g, '').slice(0, 6); // 全角の数字や空白を直す
  if (/^\d{6}$/.test(input.value) && input.form.checkValidity()) input.form.requestSubmit();
});

/** スタッフ向け: データの保存が失敗し続けているときに、画面の上に警告を出す（1分ごとに確かめる） */
function watchStorage(first) {
  const bar = el('p', { class: 'alarm', role: 'alert', hidden: true, text: 'データの保存に失敗しています。競りを進める前に、システムの担当者へ連絡してください。' });
  document.body.prepend(bar);
  const show = (me) => { bar.hidden = !me?.storageFailing; };
  show(first);
  setInterval(async () => show(await api('GET', '/api/me')), 60000);
}

/** ヘッダーの右側（ログインの状態に合わせる） */
async function setupNav() {
  const nav = $('#nav');
  const me = await api('GET', '/api/me');
  if (me.staff) watchStorage(me);
  if (nav) {
    const link = (href, text) => el('a', { href, text });
    const here = location.pathname;
    const items = [];
    if (me.member) {
      if (here !== '/mypage.html') items.push(link('/mypage.html', 'マイページ'));
    } else if (!me.staff) {
      if (here !== '/login.html') items.push(link('/login.html', 'ログイン'));
      if (here !== '/register.html') items.push(link('/register.html', '会員登録'));
    }
    if (me.staff && here !== '/staff.html') items.push(link('/staff.html', '管理'));
    if (me.member || me.staff) {
      items.push(el('button', { class: 'linkbtn', type: 'button', text: 'ログアウト', onclick: async () => { await api('POST', '/api/logout'); location.href = me.staff ? '/staff.html' : '/'; } }));
    }
    nav.replaceChildren(...items);
  }
  if (me.member) tabBar();
  return me;
}

// ---- 下のタブバー（スマートフォン）。会員の行き先は4つだけなので、いつも画面の下に出しておく
// 下のタブバーのアイコン。b は形（選んでいるタブでは塗りつぶす）、d は中の線（塗ったときは地の色で抜く）
const ICONS = {
  home: { b: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z' },
  // 木槌（頭・柄・台）。小さくても「競り」と分かる形
  bid: { b: 'M13.6 2.4l6 6-3.6 3.6-6-6zM12.4 8.4l1.7 1.7-8.3 8.3a1.2 1.2 0 0 1-1.7-1.7zM11 19h10v2.5H11z' },
  bill: { b: 'M6 3h12v18l-3-2-3 2-3-2-3 2z', d: 'M9 8h6M9 12h6' },
  me: { b: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0z' },
};
const TABS = [['/', 'ホーム', 'home'], ['/bidder.html', '競り', 'bid'], ['/mypage.html#bills', '請求書', 'bill'], ['/mypage.html#profile', 'マイページ', 'me']];
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  for (const [cls, d] of Object.entries(ICONS[name])) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d); path.setAttribute('class', cls);
    svg.append(path);
  }
  return svg;
}
function markTab() {
  const here = location.pathname === '/index.html' ? '/' : location.pathname;
  const hash = location.hash || (here === '/mypage.html' ? '#bills' : '');
  for (const a of document.querySelectorAll('.tabbar a')) {
    const [path, h = ''] = a.getAttribute('href').split('#');
    if (path === here && (!h || '#' + h === hash)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}
function tabBar() {
  if ($('.tabbar')) return;
  document.body.append(el('nav', { class: 'tabbar', 'aria-label': 'おもなページ' }, TABS.map(([href, text, name]) => el('a', { href }, icon(name), el('span', { text })))));
  document.body.classList.add('has-tabbar');
  if (location.pathname === '/' || location.pathname === '/index.html') document.body.classList.add('is-home');
  markTab();
}

// ---- パスワードの欄に「表示」の切り替えを付ける（打ちまちがいに、自分で気づけるように）
function revealable(input) {
  if (input.dataset.reveal) return;
  input.dataset.reveal = '1';
  // 文字ではなく、目のアイコン（見せている間は、斜線のない目）。名前は読み上げ用に付ける
  const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/></svg>';
  const btn = el('button', { class: 'reveal', type: 'button', 'aria-pressed': 'false', 'aria-label': 'パスワードを表示する' });
  btn.innerHTML = EYE_OFF;
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.innerHTML = show ? EYE : EYE_OFF;
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示する');
  });
  const wrap = el('span', { class: 'revealwrap' });
  input.replaceWith(wrap);
  wrap.append(input, btn);
}
const revealAll = (root = document) => root.querySelectorAll('input[type=password]').forEach(revealable);
revealAll();
// あとから出る入力欄（ダイアログの中）にも付ける
new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) revealAll(n); }).observe(document.body, { childList: true, subtree: true });

// ---- ホーム画面に追加の案内（発注者の指示）。#installSlot のあるページ（トップの下のほう）にだけ出す。
// Android の Chrome などは、ブラウザが出す「インストール」の画面を、ボタンから呼ぶ。iPhone・iPad には、その仕組みが無いので、手順を出す。
// ホーム画面から開いている間と、「閉じる」を押したあとは出さない（閉じたことは、この端末のブラウザにだけ覚える）。
let installEvent = null;
const INSTALL_KEY = 'installHidden';
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android/.test(navigator.userAgent);
function installHidden() { try { return localStorage.getItem(INSTALL_KEY) === '1'; } catch { return false; } }
function hideInstall(remember) {
  if (remember) { try { localStorage.setItem(INSTALL_KEY, '1'); } catch { /* 覚えられなくても、閉じるだけはする */ } }
  $('#installCard')?.remove();
}
function showInstall() {
  const slot = $('#installSlot');
  if (!slot || isStandalone() || installHidden()) return;
  const how = installEvent ? 'prompt' : isIos() ? 'ios' : isAndroid() ? 'android' : null;
  if (!how) return; // パソコンで、ブラウザに仕組みが無いときは出さない
  const steps = how === 'ios'
    ? ['「共有」ボタン（四角に上向きの矢印）を押す。無ければ「…」の中', '「ホーム画面に追加」を選ぶ（一覧の下のほう）', '「追加」を押す']
    : how === 'android' ? ['ブラウザのメニュー（右上の「︙」）を押す', '「ホーム画面に追加」か「アプリをインストール」を選ぶ'] : [];
  const close = el('button', { class: 'install__close', type: 'button', 'aria-label': '閉じる', onclick: () => hideInstall(true) });
  close.innerHTML = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2 2 12"/></svg>';
  const card = el('section', { class: 'install card', id: 'installCard', 'aria-labelledby': 'installTitle' }, close,
    el('img', { class: 'install__icon', src: 'icon-192.png', width: 56, height: 56, alt: '' }),
    el('div', { class: 'install__body' },
      el('h2', { id: 'installTitle', text: 'ホーム画面に追加' }),
      steps.length ? el('ol', { class: 'install__steps' }, steps.map((text) => el('li', { text }))) : null,
      how === 'prompt' ? el('div', { class: 'actions' },
        el('button', { class: 'btn btn-primary', type: 'button', text: '追加する', onclick: async () => {
          const ev = installEvent; installEvent = null;
          if (!ev) return;
          ev.prompt();
          const { outcome } = await ev.userChoice.catch(() => ({ outcome: 'dismissed' }));
          hideInstall(outcome === 'accepted');
        } })) : null));
  $('#installCard')?.remove();
  slot.append(card);
}
addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); installEvent = ev; showInstall(); });
addEventListener('appinstalled', () => hideInstall(true));
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showInstall); else showInstall();

/** タブの並び（role=tablist）を、矢印キー（横並びでも縦並びでも、上下左右）・Home・End で移れるようにする（選んだタブだけが Tab で止まる。報告書 81 章） */
function tabKeys(list) {
  list.addEventListener('keydown', (ev) => {
    const tabs = [...list.querySelectorAll('[role=tab]')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: tabs.length - 1 }[ev.key];
    if (next === undefined) return;
    ev.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length];
    t.focus(); t.click();
  });
}
