// 出品カタログ（登録していない人も見られる）。開始価格は、すべての人に同じ金額をそのまま見せる。
'use strict';

const when = (e) => `${dateFmt.format(new Date(e.startsAt + ':00+09:00'))} 〜 ${e.endsAt.slice(11)}`;

function openDetail(item) {
  $('#detailNo').textContent = `No. ${item.no}`;
  $('#detailTitle').textContent = item.title;
  // 大きな写真は、あるときだけ作る
  const hero = item.photos.length ? el('img', { class: 'hero', src: item.photos[0].url, alt: item.title }) : null;
  $('#detailHero').replaceChildren(...(hero ? [hero] : []));
  $('#detailThumbs').replaceChildren(...(item.photos.length > 1 ? item.photos.map((p, i) => el('figure', {},
    el('img', { src: p.url, alt: `写真 ${i + 1}`, loading: 'lazy', onclick: () => { hero.src = p.url; } }))) : []));
  const facts = [['開始価格（税込）', yen(item.startPrice)], ['数量', String(item.quantity)], ['サイズ', item.size], ['状態', item.condition], ['放出品の情報', item.surplusInfo], ['説明', item.description]];
  $('#detailFacts').replaceChildren(...facts.filter(([, v]) => v).flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { class: 'pre dyn', text: v })]));
  $('#detail').showModal();
}

async function load() {
  setupNav();
  const res = await api('GET', '/api/catalog');
  const root = $('#events');
  if (!res.ok) return root.replaceChildren(el('p', { class: 'empty', text: res.message }));
  if (!res.events.length) return root.replaceChildren(el('p', { class: 'empty', text: '公開中の開催はありません。' }));
  root.replaceChildren(...res.events.map((e) => el('section', { class: 'event' },
    el('header', {}, el('h2', { class: 'dyn', text: e.title }), el('p', { class: 'dyn', text: `${when(e)}　${e.venueName}（${e.venueAddress}）` })),
    e.items.length
      ? el('ul', { class: 'cards' }, e.items.map((item) => el('li', { class: 'card' },
        el('button', { type: 'button', onclick: () => openDetail(item) },
          item.photos[0] ? el('img', { class: 'thumb', src: item.photos[0].url, alt: '', loading: 'lazy' }) : el('div', { class: 'thumb', text: '写真なし' }),
          el('span', { class: 'no', text: `No. ${item.no}` }),
          el('h3', { class: 'dyn', text: item.title }),
          el('span', { class: 'from' }, '開始価格（税込）', el('b', { class: 'digits', text: yen(item.startPrice) }))))))
      : el('p', { class: 'empty', text: '出品の準備中です。' }))));
  $('#shipping').textContent = res.shippingNotice;
  $('#returns').textContent = res.returnPolicy;
  $('#terms').hidden = false;
}
$('#detailClose').addEventListener('click', () => $('#detail').close());
load();
