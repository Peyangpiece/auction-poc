// ログイン: 電話番号と SMS の認証番号（パスワードは使わない）。
'use strict';

const phoneForm = $('#stepPhone');
const codeForm = $('#stepCode');
let phone = '';
// 入札画面から来た人は、ログインのあと入札画面へ戻す（行き先は決まった2つだけ。外のサイトへは飛ばさない）
const after = new URLSearchParams(location.search).get('next') === 'bidder' ? '/bidder.html' : '/mypage.html';

onSubmit(phoneForm, async (data) => {
  phone = data.phone;
  const res = await api('POST', '/api/login/start', { phone });
  if (res.ok) {
    $('#sentTo').textContent = `登録済みの番号であれば、${phone} に認証番号を送りました`;
    if (res.devCode) $('#sentTo').textContent += `　【お試し用】認証番号 ${res.devCode}`;
    phoneForm.hidden = true;
    codeForm.hidden = false;
    codeForm.elements.code.focus();
  }
  return res;
});
onSubmit(codeForm, async (data) => {
  const res = await api('POST', '/api/login/verify', { phone, code: data.code });
  if (res.ok) location.href = after;
  else codeForm.elements.code.value = '';
  return res;
});
$('#resend').addEventListener('click', async (ev) => {
  ev.target.disabled = true;
  const res = await api('POST', '/api/login/start', { phone });
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
  else phoneForm.elements.phone.focus();
})();
