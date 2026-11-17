// 規約類: 利用規約・特定商取引法に基づく表示・プライバシーポリシー。文面は、主催者管理者が管理画面で入れたもの。
'use strict';

(async () => {
  setupNav();
  const res = await api('GET', '/api/legal');
  if (!res.ok) return $('#docs').replaceChildren(el('p', { class: 'empty', text: res.message }));
  $('#docs').replaceChildren(...Object.entries(res.docs).map(([id, d]) => el('section', { class: 'legaldoc', id },
    el('h2', { text: d.title }), el('p', { class: 'pre dyn', text: d.body || '準備中です。' }))));
  // 「#terms」などで開いたときに、その場所へ送る（中身があとから入るので、ここで動かす）
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
})();
