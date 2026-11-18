// マイページ: 「請求書」（請求書の一覧と、落札した品）と、「個人情報の設定」（登録内容の確認・変更、退会）の2つのタブ。
'use strict';

let profile = null;
// お試し用（メールの送信サービスをつなぐ前）: 確認のリンクを、画面に出す
function showDevVerify(url) {
  $('#emailBanner').append(el('a', { class: 'btn', href: url, text: '【お試し用】確認のリンクを開く' }));
}
(async () => {
  const me = await setupNav();
  const m = me.member;
  if (!m) return location.replace('/login.html');
  const q = new URLSearchParams(location.search);
  const notice = q.get('registered') ? '登録が済みました。確認のメールをお送りしました。'
    : q.get('email') === 'verified' ? 'メールアドレスを確認しました。'
    : q.get('email') === 'expired' ? '' : '';
  $('#notice').textContent = notice;
  if (q.get('email') === 'expired' && !m.emailVerified) $('#emailText').textContent = '確認のリンクの期限が切れています。もう一度お送りします。';
  history.replaceState(null, '', location.pathname + location.hash);
  // 会員登録の直後と、メールの確認のあとは、登録の内容が見えるように「個人情報の設定」を開く
  if (q.get('registered') || q.get('email')) showTab('profile');
  profile = m;
  // 認証番号で入った人（パスワードを忘れた人）には、新しいパスワードを決める画面を、すぐに出す
  $('#pwBtn').textContent = m.hasPassword ? 'パスワードを変更する' : 'ログイン ID とパスワードを決める';
  if (q.get('reset')) { showTab('profile'); $('#notice').textContent = '新しいパスワードを決めてください。'; openPassword(true); }

  $('#suspended').hidden = !m.suspended;
  // 停止の理由は、手動と未払いで言葉を分ける（FR-BID-012）
  if (m.suspendedBy === 'unpaid') $('#suspended span').textContent = 'お支払いの確認が取れていない請求があるため、参加を停止しています。お支払いの確認が取れると、自動で解除されます。';
  loadBilling();
  $('#emailBanner').hidden = m.emailVerified;
  const dev = sessionStorage.getItem('devVerifyUrl'); sessionStorage.removeItem('devVerifyUrl');
  if (dev && !m.emailVerified) showDevVerify(dev);
  const rows = [
    ['ログイン ID', m.loginId], ['区分', m.kind === 'b2b' ? '法人' : '個人'],
    ['会社名', m.company], ['担当者名', m.contactName], ['氏名', m.name], ['フリガナ', m.nameKana], ['電話番号', telFmt(m.phone) + (m.phoneVerified ? '' : '（未確認。ログインには、メールアドレスをお使いください）')],
    ['メールアドレス', m.email + (m.emailVerified ? '（確認済み）' : '（未確認）')],
    ['住所', m.address], ['配送先', m.shipTo], ['請求先', m.billing],
  ];
  profile = m;
  $('#eventMail').checked = m.eventMail;
  $('#facts').replaceChildren(...rows.filter(([, v]) => v).flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { class: 'pre dyn', text: v })]));
})();

// 開催のお知らせメールの受け取り。切り替えたら、すぐ保存する（失敗したら、元に戻す）
$('#eventMail').addEventListener('change', async (ev) => {
  const box = ev.target;
  box.disabled = true;
  const res = await api('POST', '/api/my/event-mail', { on: box.checked });
  box.disabled = false;
  if (!res.ok) { box.checked = !box.checked; $('#accountMsg').textContent = res.message; return; }
  $('#notice').textContent = res.eventMail ? '開催のお知らせメールを、お送りします。' : '開催のお知らせメールを、止めました。';
});

$('#resendEmail').addEventListener('click', async (ev) => {
  ev.target.disabled = true;
  const res = await api('POST', '/api/email/resend');
  $('#emailText').textContent = res.ok ? '確認のメールをお送りしました。メールの中のリンクを開いてください。' : res.message;
  if (res.devVerifyUrl) showDevVerify(res.devVerifyUrl);
  if (!res.ok) ev.target.disabled = false;
});

// ---- 落札した品とお支払い（請求書、支払期限、受け取り期限、繰り上げのご案内）
const STATE_TEXT = { unsettled: 'お支払い前', billed: 'ご請求済み', unpaid: 'お支払いの期限を過ぎています', cleared: 'お支払い済み', delivered: 'お渡し済み', cancelled: '解除されました' };
const RECEIVE_TEXT = { pickup: '現地受け取り', ship: '配送' };
const INVOICE_STATE = { paid: 'お支払い済み', overdue: 'お支払いの期限を過ぎています', billed: 'お支払い前' };
// 請求書の一覧: 請求番号・発行日・金額・お支払期限・状態と、PDF を開くボタン
function showInvoices(list) {
  if (!list.length) return;
  $('#invoices').replaceChildren(el('ul', { class: 'rows invlist' }, list.map((i) => el('li', {},
    el('div', { class: 'invlist__main' },
      el('b', { text: `${jpDay(i.issuedOn)}の請求書` }),
      el('span', { class: 'note', text: [`No.${i.number}`, i.dueDate && i.state !== 'paid' ? `お支払期限 ${jpDay(i.dueDate)}` : ''].filter(Boolean).join('　') })),
    el('span', { class: 'digits invlist__total', text: yen(i.total) }),
    el('span', { class: i.state === 'overdue' ? 'warn' : 'invlist__state', text: INVOICE_STATE[i.state] }),
    el('a', { class: 'btn', href: `/api/billing/invoices/${i.id}/pdf`, text: '請求書を開く（PDF）' })))));
}
async function loadBilling() {
  const res = await api('GET', '/api/my/billing');
  if (res.ok) showInvoices(res.invoices ?? []);
  if (!res.ok || (!res.lines.length && !res.offers.length)) return;
  $('#billing').hidden = false;
  $('#offers').replaceChildren(...res.offers.filter((o) => o.state === 'open').map((o) => el('div', { class: 'banner' },
    el('span', { text: `繰り上げ落札のご案内: ${o.label} を ${yen(o.amount)}（税込）で。回答期限 ${o.deadline}` }),
    el('span', {},
      el('button', { class: 'btn btn-primary', type: 'button', text: '承諾する', onclick: async () => { await api('POST', `/api/my/offers/${o.id}`, { answer: 'accept' }); loadBilling(); } }), ' ',
      el('button', { class: 'btn', type: 'button', text: '辞退する', onclick: async () => { await api('POST', `/api/my/offers/${o.id}`, { answer: 'decline' }); loadBilling(); } })))));
  $('#myLines').replaceChildren(...res.lines.map((l) => el('li', {},
    el('b', { text: l.label }), el('span', { class: 'digits', text: yen(l.payable) }),
    el('span', { class: 'tag', 'data-state': l.state, text: STATE_TEXT[l.state] }),
    el('span', { class: 'note', text: [
      l.premium ? `落札額 ${yen(l.amount)}＋買歩銭 ${yen(l.premium)}` : '',
      l.receive && l.kind !== 'penalty' && l.kind !== 'late' ? `受け取り: ${RECEIVE_TEXT[l.receive]}` : '',
      l.invoice?.dueDate && l.state !== 'cleared' && l.state !== 'delivered' ? `お支払期限 ${jpDay(l.invoice.dueDate)}` : '',
      l.pickupBy && l.state === 'cleared' ? `受け取り期限 ${jpDay(l.pickupBy)}` : '',
    ].filter(Boolean).join('　') }))));
}

// ---- 登録内容の変更と、退会
const dlg = $('#dlg');
$('#editBtn').addEventListener('click', () => {
  const m = profile;
  const corp = m.kind === 'b2b';
  const form = el('form', { class: 'form', novalidate: true },
    corp && field('会社名', 'company', { value: m.company, required: true }),
    corp && field('担当者名', 'contactName', { value: m.contactName, required: true }),
    corp && field('請求先', 'billing', { value: m.billing, rows: 2, required: true, autocomplete: 'off' }),
    field('メールアドレス', 'email', { value: m.email, type: 'email', required: true, autocomplete: 'email' }, '変えると、新しいアドレスに確認のメールを送ります'),
    ...personFields(m),
    field('配送先', 'shipTo', { value: m.shipTo ?? '', rows: 2, autocomplete: 'off' }, '住所と違う場合だけ'),
    el('p', { class: 'note', text: '電話番号の変更は、本人の確認が要るため、会場の受付にお申し出ください。' }),
    el('p', { class: 'msg', role: 'alert', tabIndex: -1 }),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '保存する' }), el('button', { class: 'btn', type: 'button', text: 'やめる', onclick: () => dlg.close() })));
  onSubmit(form, async (data) => { const res = await api('POST', '/api/my/profile', data); if (res.ok) location.reload(); return res; });
  dlg.replaceChildren(el('h2', { text: '登録内容の変更' }), form);
  dlg.showModal();
});
// ---- パスワードの変更（ログイン ID は、発行されたものを使い続ける。まだ無い人は、ここで決める）
function openPassword(reset = false) {
  const m = profile;
  const form = el('form', { class: 'form', novalidate: true },
    m.loginId ? el('p', { class: 'verified', text: `ログイン ID: ${m.loginId}` }) : field('ログイン ID', 'loginId', { required: true, autocomplete: 'username', autocapitalize: 'none', spellcheck: false }, '半角の英数字と . _ - で、4〜32文字'),
    m.hasPassword && !reset && field('いまのパスワード', 'currentPassword', { type: 'password', required: true, autocomplete: 'current-password' }),
    field('新しいパスワード', 'password', { type: 'password', required: true, autocomplete: 'new-password' }, '8文字以上'),
    field('新しいパスワード（もう一度）', 'password2', { type: 'password', required: true, autocomplete: 'new-password' }),
    el('p', { class: 'msg', role: 'alert', tabIndex: -1 }),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '保存する' }), el('button', { class: 'btn', type: 'button', text: 'やめる', onclick: () => dlg.close() })));
  onSubmit(form, async (data) => {
    if (data.password !== data.password2) return { ok: false, message: '入力を確かめてください', errors: { password2: '新しいパスワードが、2つの欄で違っています' } };
    const res = await api('POST', '/api/my/credentials', { loginId: m.loginId ?? data.loginId, password: data.password, currentPassword: data.currentPassword });
    if (res.ok) { dlg.close(); profile = res.member; $('#notice').textContent = 'パスワードを保存しました。次からは、ログイン ID とこのパスワードで、ログインできます。'; $('#pwBtn').textContent = 'パスワードを変更する'; }
    return res;
  });
  dlg.replaceChildren(el('h2', { text: m.hasPassword ? 'パスワードの変更' : 'ログイン ID とパスワードを決める' }), form);
  dlg.showModal();
}
$('#pwBtn').addEventListener('click', () => openPassword(false));
$('#withdrawBtn').addEventListener('click', () => {
  const msg = el('p', { class: 'msg', role: 'alert' });
  dlg.replaceChildren(el('h2', { text: '退会しますか？' }),
    el('p', { text: '退会すると、ログインできなくなります。お取引の記録は、法令で定められた期間、保管します。' }), msg,
    el('div', { class: 'actions' },
      el('button', { class: 'btn btn-danger', type: 'button', text: '退会する', onclick: async () => { const res = await api('POST', '/api/my/withdraw'); if (res.ok) location.href = '/'; else msg.textContent = res.message; } }),
      el('button', { class: 'btn', type: 'button', text: 'やめる', onclick: () => dlg.close() })));
  dlg.showModal();
});

// ---- タブ（開いているタブを URL に載せる。#bills / #profile）
function showTab(key) {
  for (const b of $('#myTabs').children) b.setAttribute('aria-selected', String(b.dataset.tab === key));
  $('#panel-bills').hidden = key !== 'bills';
  $('#panel-profile').hidden = key !== 'profile';
  if (location.hash.slice(1) !== key) history.replaceState(null, '', `#${key}`);
  markTab();
  // スマートフォンでは、下のタブバーが「請求書」と「マイページ」を分けているので、見出しも、それに合わせる
  if (matchMedia('(max-width: 640px)').matches) $('.pagehead h1').textContent = key === 'bills' ? '請求書' : 'マイページ';
}
for (const b of $('#myTabs').children) b.addEventListener('click', () => showTab(b.dataset.tab));
// 下のタブバー（請求書／マイページ）から来たときも、開くタブを切り替える
addEventListener('hashchange', () => { if (location.hash === '#profile' || location.hash === '#bills') showTab(location.hash.slice(1)); });
$('#logoutBtn').addEventListener('click', async () => { await api('POST', '/api/logout'); location.href = '/'; });
if (location.hash === '#profile') showTab('profile');
