// トップページ: 会員登録・ログインへの入口と、送料・返品の表示。
'use strict';

(async () => {
  const me = await setupNav();
  if (me.member || me.staff) $('#lead').hidden = true;
  const res = await api('GET', '/api/terms');
  if (!res.ok) return;
  $('#shipping').textContent = res.shippingNotice;
  $('#returns').textContent = res.returnPolicy;
  $('#terms').hidden = false;
})();
