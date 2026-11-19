// 開催のお知らせメールの配信の停止（メールのリンクから。ログインは要らない。報告書 96 章）
'use strict';

(() => {
  setupNav();
  const t = new URLSearchParams(location.search).get('t') || '';
  // 合言葉は、アドレス欄から消す（画面を共有したり、履歴に残ったりしないように）
  if (t) history.replaceState(null, '', location.pathname);
  const go = $('#unsubGo'), msg = $('#unsubMsg');
  if (!t) { go.hidden = true; msg.textContent = 'このリンクは使えません。マイページの「個人情報の設定」から止めてください。'; return; }
  // 止めるのは、ボタンを押したときだけ（メールのリンクを、迷惑メール対策の仕組みが先に開いても、止まらないように）
  go.addEventListener('click', async () => {
    go.disabled = true; go.textContent = '処理中…';
    const res = await api('POST', '/api/unsubscribe', { t });
    if (res.ok) { go.hidden = true; msg.textContent = '配信を止めました。もう一度受け取るときは、マイページの「個人情報の設定」で切り替えてください。'; }
    else { go.disabled = false; go.textContent = '配信を止める'; msg.textContent = res.message ?? 'うまくいきませんでした。もう一度お試しください。'; }
  });
})();
