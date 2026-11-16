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
    if (button) button.disabled = true;
    const res = await handler(Object.fromEntries(new FormData(form)), button);
    if (button) button.disabled = false;
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

/** ヘッダーの右側（ログインの状態に合わせる） */
async function setupNav() {
  const nav = $('#nav');
  const me = await api('GET', '/api/me');
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
