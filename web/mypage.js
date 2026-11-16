// マイページ: 登録した内容の確認と、メールアドレスの確認の状態。
'use strict';

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
  history.replaceState(null, '', location.pathname);

  $('#suspended').hidden = !m.suspended;
  $('#emailBanner').hidden = m.emailVerified;
  const rows = [
    ['区分', m.kind === 'b2b' ? '法人' : '個人'],
    ['会社名', m.company], ['担当者名', m.contactName], ['氏名', m.name], ['電話番号', m.phone],
    ['メールアドレス', m.email + (m.emailVerified ? '（確認済み）' : '（未確認）')],
    ['住所', m.address], ['配送先', m.shipTo], ['請求先', m.billing],
  ];
  $('#facts').replaceChildren(...rows.filter(([, v]) => v).flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { class: 'pre dyn', text: v })]));
})();

$('#resendEmail').addEventListener('click', async (ev) => {
  ev.target.disabled = true;
  const res = await api('POST', '/api/email/resend');
  $('#emailText').textContent = res.ok ? '確認のメールをお送りしました。メールの中のリンクを開いてください。' : res.message;
  if (!res.ok) ev.target.disabled = false;
});
