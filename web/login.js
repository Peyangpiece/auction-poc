// ログイン: ログイン ID とパスワード（主催者の承認のメールで届いたもの）。
// パスワードを忘れた人は、携帯電話の番号か、確認済みのメールアドレスに届く認証番号で入り、マイページで決め直す。
'use strict';

const phoneForm = $('#stepPhone');
const codeForm = $('#stepCode');
let phone = '';
// 入札画面から来た人は、ログインのあと入札画面へ戻す（行き先は決まった2つだけ。外のサイトへは飛ばさない）
const after = new URLSearchParams(location.search).get('next') === 'bidder' ? '/bidder.html' : '/';
const pwForm = $('#pwForm');
// SMS を使わない設定（本番）のときは、連絡先の欄を、メールアドレスだけにする
api('GET', '/api/terms').then((t) => {
  if (t.sms !== false) return;
  const input = phoneForm.elements.id;
  input.closest('label').firstChild.textContent = 'メールアドレス';
  input.type = 'email'; input.placeholder = 'taro@example.com'; input.autocomplete = 'email';
  const note = phoneForm.querySelector('.note');
  if (note) note.textContent = '登録したメールアドレスに、認証番号をお送りします。ログインのあと、マイページで、新しいパスワードを決めてください。';
});

onSubmit(pwForm, async (data) => {
  const res = await api('POST', '/api/login/password', { loginId: data.loginId, password: data.password });
  if (res.ok) location.href = after;
  else pwForm.elements.password.value = '';
  return res;
});
// パスワードを忘れた方: 認証番号でのログインに切り替える
$('#forgot').addEventListener('click', () => { pwForm.hidden = true; phoneForm.hidden = false; phoneForm.elements.id.focus(); });
$('#backToPw').addEventListener('click', () => { phoneForm.hidden = true; codeForm.hidden = true; pwForm.hidden = false; pwForm.elements.loginId.focus(); });

onSubmit(phoneForm, async (data) => {
  phone = data.id.trim();
  const res = await api('POST', '/api/login/start', { id: phone });
  if (res.ok) {
    $('#sentTo').textContent = res.via === 'email'
      ? `確認済みのアドレスであれば、${phone} に認証番号を送りました。届かない場合は、携帯電話の番号でお試しください`
      : `登録済みの番号であれば、${phone} に認証番号を送りました`;
    if (res.devCode) $('#sentTo').textContent += `　【お試し用】認証番号 ${res.devCode}`;
    phoneForm.hidden = true;
    codeForm.hidden = false;
    codeForm.elements.code.focus();
  }
  return res;
});
onSubmit(codeForm, async (data) => {
  const res = await api('POST', '/api/login/verify', { id: phone, code: data.code });
  // 認証番号で入った人は、マイページで、新しいパスワードを決める
  if (res.ok) location.href = after === '/' ? '/mypage.html?reset=1#profile' : after;
  else codeForm.elements.code.value = '';
  return res;
});
$('#resend').addEventListener('click', async (ev) => {
  ev.target.disabled = true;
  const res = await api('POST', '/api/login/start', { id: phone });
  const msg = $('.msg', codeForm);
  msg.classList.toggle('ok', res.ok);
  msg.textContent = res.ok ? '認証番号を送り直しました' : res.message;
  setTimeout(() => { ev.target.disabled = false; }, 10000);
});

(async () => {
  // 入札画面から来た人が会員登録へ進むときも、行き先を引き継ぐ
  if (after === '/bidder.html') for (const link of document.querySelectorAll('a[href="/register.html"]')) link.href = '/register.html?next=bidder';
  const me = await setupNav();
  if (me.member) location.replace(after);
  else pwForm.elements.loginId.focus();
})();
