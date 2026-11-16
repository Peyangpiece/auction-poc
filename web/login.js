// ログイン: 電話番号と SMS の認証番号（パスワードは使わない）。
'use strict';

const phoneForm = $('#stepPhone');
const codeForm = $('#stepCode');
let phone = '';

onSubmit(phoneForm, async (data) => {
  phone = data.phone;
  const res = await api('POST', '/api/login/start', { phone });
  if (res.ok) {
    $('#sentTo').textContent = `登録済みの番号であれば、${phone} に認証番号を送りました`;
    phoneForm.hidden = true;
    codeForm.hidden = false;
    codeForm.elements.code.focus();
  }
  return res;
});
onSubmit(codeForm, async (data) => {
  const res = await api('POST', '/api/login/verify', { phone, code: data.code });
  if (res.ok) location.href = '/mypage.html';
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
  const me = await setupNav();
  if (me.member) location.replace('/mypage.html');
  else phoneForm.elements.phone.focus();
})();
