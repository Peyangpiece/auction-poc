// 会員・スタッフ用の画面の共通部品。
'use strict';

const yenFmt = new Intl.NumberFormat('ja-JP');
const yen = (n) => (n === null || n === undefined ? '' : '¥' + yenFmt.format(n));
const dateFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const $ = (sel, root = document) => root.querySelector(sel);

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
  return el('label', { class: 'field' }, label, hint && el('small', { text: hint }), input, el('span', { class: 'err', role: 'alert' }));
}

const PREFECTURES = '北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県'.split(' ');

/** ラベルの横に付ける「必須」「任意」の印 */
const mark = (required) => el('span', { class: required ? 'req' : 'opt', text: required ? '必須' : '任意' });
/** ラベル・印・補足・入力欄・エラーをまとめた1欄 */
function labeled(label, required, input, hint = '') {
  return el('label', { class: 'field' }, el('span', { class: 'field__label' }, label, mark(required)), hint && el('small', { text: hint }), input, el('span', { class: 'err', role: 'alert' }));
}

/**
 * お名前・フリガナ・ご住所の入力欄（会員登録と、登録内容の変更で使う）。
 * 郵便番号を7桁入れると、都道府県と市区町村を自動で入れる。
 */
function personFields(m = {}) {
  const [last = '', first = ''] = String(m.name ?? '').split(/[\s　]+/);
  const [lastKana = '', firstKana = ''] = String(m.nameKana ?? '').split(/[\s　]+/);
  const input = (name, props) => el('input', { class: 'input', name, ...props });
  const zip = input('postalCode', { value: m.postalCode ?? '', inputMode: 'numeric', autocomplete: 'postal-code', placeholder: '1000001', maxLength: 8, required: true });
  const pref = el('select', { class: 'input', name: 'prefecture', autocomplete: 'address-level1', required: true },
    el('option', { value: '', text: '選んでください' }), PREFECTURES.map((p) => el('option', { value: p, text: p })));
  pref.value = m.prefecture ?? '';
  const a1 = input('address1', { value: m.address1 ?? (m.postalCode ? '' : m.address ?? ''), // 前の版で登録した人は、まとめて書いた住所をここに出す
    autocomplete: 'address-line1', placeholder: '千代田区千代田1-1', required: true });
  const a2 = input('address2', { value: m.address2 ?? '', autocomplete: 'address-line2', placeholder: '○○マンション 101号室' });
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
      labeled('姓', true, input('lastName', { value: last, autocomplete: 'family-name', placeholder: '山田', required: true })),
      labeled('名', true, input('firstName', { value: first, autocomplete: 'given-name', placeholder: '太郎', required: true }))),
    el('div', { class: 'pair' },
      labeled('セイ', true, input('lastKana', { value: lastKana, autocomplete: 'off', placeholder: 'ヤマダ', required: true })),
      labeled('メイ', true, input('firstKana', { value: firstKana, autocomplete: 'off', placeholder: 'タロウ', required: true }))),
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
  return me;
}
