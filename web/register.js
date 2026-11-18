// 会員登録: 携帯電話の番号かメールアドレス → 認証番号 → お客様の情報。
'use strict';

const forms = { phone: $('#stepPhone'), code: $('#stepCode'), profile: $('#stepProfile') };
let phone = '';

function show(step) {
  const order = ['phone', 'code', 'profile'];
  order.forEach((name, i) => {
    forms[name].hidden = name !== step;
    const li = $('#steps').children[i];
    if (name === step) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  forms[step].querySelector('input:not([type=radio])')?.focus();
}

// SMS を使わない設定（本番）のときは、連絡先の欄を、メールアドレスだけにする
api('GET', '/api/terms').then((t) => {
  if (t.sms !== false) return;
  const input = forms.phone.elements.id;
  input.closest('label').firstChild.textContent = 'メールアドレス';
  input.type = 'email'; input.placeholder = 'taro@example.com'; input.autocomplete = 'email';
  const note = forms.phone.querySelector('.note');
});

onSubmit(forms.phone, async (data) => {
  phone = data.id.trim();
  const res = await api('POST', '/api/register/start', { id: phone });
  if (res.ok) { $('#sentTo').textContent = `${phone} に送りました。5分以内に入力してください`; show('code'); }
  if (res.devCode) $('#sentTo').textContent += `　【お試し用】認証番号 ${res.devCode}`;
  else if (res.login) res.message = '登録済みです。下の「ログイン」からお入りください';
  return res;
});
onSubmit(forms.code, async (data) => {
  const res = await api('POST', '/api/register/verify', { id: phone, code: data.code });
  if (res.ok) { setContact(res.via, phone); show('profile'); }
  else forms.code.elements.code.value = '';
  return res;
});
$('#resend').addEventListener('click', async (ev) => {
  ev.target.disabled = true;
  const res = await api('POST', '/api/register/start', { id: phone });
  const msg = $('.msg', forms.code);
  msg.classList.toggle('ok', res.ok);
  msg.textContent = res.ok ? '認証番号を送り直しました' : res.message;
  setTimeout(() => { ev.target.disabled = false; }, 10000); // 続けて押せないようにする
});

// お名前・フリガナ・ご住所の欄を置く
$('#person').append(...personFields());
// 配送先: 住所と同じなら、欄を出さない
$('#shipSame').addEventListener('change', (ev) => { $('#shipRow').hidden = ev.target.checked; if (ev.target.checked) forms.profile.elements.shipTo.value = ''; });

// 確かめた連絡先に合わせて、もう片方を入力してもらう（メールで確かめた人は電話番号、電話で確かめた人はメール）
function setContact(via, id) {
  const byEmail = via === 'email';
  const f = forms.profile.elements;
  $('#phoneRow').hidden = !byEmail; f.phone.disabled = !byEmail;
  $('#emailRow').hidden = byEmail; f.email.disabled = byEmail;
  $('#verifiedEmail').hidden = !byEmail;
  if (byEmail) $('#verifiedEmail').textContent = `メールアドレス: ${id}（確認済み）`;
}

function syncKind() {
  const corp = forms.profile.elements.kind.value === 'b2b';
  $('#corp').hidden = !corp;
  $('#adultRow').hidden = corp; // 18歳以上の申告は、個人だけ
}
forms.profile.addEventListener('change', syncKind);
// 入力の途中でページを離れようとしたら、確かめる（書いた内容が消えるため）。登録が済んだら外す
let dirty = false;
forms.profile.addEventListener('input', () => { dirty = true; });
window.addEventListener('beforeunload', (ev) => { if (dirty) ev.preventDefault(); });
onSubmit(forms.profile, async (data) => {
  const res = await api('POST', '/api/register/complete', { ...data, adult: data.adult === '1', agreed: data.agreed === '1' });
  // 入札画面（会場の QR コードなど）から来た人は、登録のあと入札画面の参加手続きへ進める（FR-AUTH-007）
  if (res.ok) dirty = false;
  // 承認待ち: ログインはまだできない。受け付けたことと、このあとの流れを伝える
  if (res.ok && res.pending) {
    for (const f of Object.values(forms)) f.hidden = true;
    $('#steps').hidden = true;
    $('#doneMail').textContent = `送り先: ${forms.profile.elements.email.disabled ? phone : data.email}`;
    $('#stepDone').hidden = false; $('#stepDone').focus();
    return res;
  }
  if (res.ok && res.devVerifyUrl) sessionStorage.setItem('devVerifyUrl', res.devVerifyUrl); // お試し用: 確認のリンクを、マイページで出す
  if (res.ok) location.href = new URLSearchParams(location.search).get('next') === 'bidder' ? '/bidder.html' : '/mypage.html?registered=1';
  else if (res.status === 401) { res.message = '時間が空いたため、連絡先の確認からやり直してください'; show('phone'); }
  return res;
});

(async () => {
  const me = await setupNav();
  if (new URLSearchParams(location.search).get('next') === 'bidder') for (const link of document.querySelectorAll('a[href="/login.html"]')) link.href = '/login.html?next=bidder';
  if (me.member) location.replace('/mypage.html');
  else if (me.registering) { setContact(me.registerVia, me.registerId); show('profile'); } // 認証まで済ませて、読み込み直した場合
  syncKind();
  // 利用規約が登録されていれば、同意の欄を出す
  const legal = await api('GET', '/api/legal');
  if (legal.ok && legal.docs.terms.body) $('#agreeRow').hidden = false;
})();
