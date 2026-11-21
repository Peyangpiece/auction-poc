// 配送の印刷（報告書 131 章）。中身は、管理画面の「配送」と同じ受け口（/api/billing/shipping）から取る。
// doc=labels（宛名ラベル）/ slips（同梱する納品書）/ sheet（梱包の作業票）。account=会員番号 で、その顧客だけ。only=open で、まだ配送していない顧客だけ
'use strict';

const q = new URLSearchParams(location.search);
const DOC = { labels: '宛名ラベル', slips: '同梱する納品書', sheet: '梱包の作業票' };
const doc = DOC[q.get('doc')] ? q.get('doc') : 'labels';

$('#doPrint').addEventListener('click', () => window.print());
$('#doClose').addEventListener('click', () => window.close());

(async () => {
  const res = await api('GET', `/api/billing/shipping?event=${encodeURIComponent(q.get('event') ?? '')}`);
  if (!res.ok) { $('#msg').textContent = res.status === 401 || res.status === 403 ? '管理画面にログインしてから、開いてください。' : (res.message ?? '読み込めませんでした。'); return; }
  const ev = res.events.find((e) => e.id === res.event);
  let list = res.customers;
  if (q.get('account')) list = list.filter((c) => String(c.accountId) === q.get('account'));
  if (q.get('only') === 'open') list = list.filter((c) => c.state !== 'shipped');
  document.title = `${DOC[doc]}｜令和の競り`;
  $('#docName').textContent = DOC[doc];
  $('#docInfo').textContent = ev ? `${jpDay(ev.date)}　${ev.title}　${list.length}人` : '';
  if (!list.length) { $('#msg').textContent = '印刷する顧客が、いません。'; return; }
  document.body.dataset.doc = doc;
  const sender = res.sender ?? {};
  const senderLines = [sender.name, ...(String(sender.address ?? '').split('\n')), sender.tel ? `TEL ${sender.tel}` : ''].filter(Boolean);
  const carrierName = (key) => res.carriers.find((x) => x.key === key)?.name ?? '';
  const evLine = ev ? `${jpDay(ev.date)}　${ev.title}` : '';

  if (doc === 'labels') {
    // 宛名ラベル: A4 に 6面（2列×3段）。1人に1面。配送先を大きく、ご依頼主（主催者）を小さく
    $('#sheet').replaceChildren(...list.map((c) => el('section', { class: 'label' },
      el('div', { class: 'label__to' },
        el('p', { class: 'label__zip', text: c.zip ? `〒${c.zip}` : '' }),
        el('p', { class: 'label__addr', text: c.address || '（住所の登録なし）' }),
        el('p', { class: 'label__name' }, c.name, el('span', { text: ' 様' })),
        el('p', { class: 'label__tel', text: c.phone ? `TEL ${c.phone}` : '' })),
      el('div', { class: 'label__from' },
        el('p', { class: 'label__fromhead', text: 'ご依頼主' }),
        ...senderLines.map((t) => el('p', { text: t }))),
      el('p', { class: 'label__ref', text: `会員番号 ${c.accountId}　${c.lines.length}点　${ev ? jpDay(ev.date) : ''}` }))));
  } else if (doc === 'slips') {
    // 納品書: 1人に1枚。品番・品名・金額（落札額＋買歩銭）。送料は、別の行
    $('#sheet').replaceChildren(...list.map((c) => {
      const total = c.lines.reduce((s, l) => s + l.payable, 0) + (c.fee?.amount ?? 0);
      return el('section', { class: 'slip' },
        el('h1', { text: '納品書' }),
        el('div', { class: 'slip__head' },
          el('div', {}, el('p', { class: 'slip__name' }, c.name, el('span', { text: ' 様' })), el('p', { text: `${c.zip ? '〒' + c.zip + '　' : ''}${c.address}` }), el('p', { class: 'small', text: `会員番号 ${c.accountId}` })),
          el('div', { class: 'slip__from' }, ...senderLines.map((t, i) => el('p', { class: i ? 'small' : '', text: t })), el('p', { class: 'small', text: evLine }))),
        el('p', { text: 'このたびは、ご落札いただき、ありがとうございます。下記の品を、お届けします。' }),
        el('table', {},
          el('thead', {}, el('tr', {}, el('th', { text: '品番・品名' }), el('th', { class: 'r', text: '落札額' }), el('th', { class: 'r', text: '買歩銭' }), el('th', { class: 'r', text: '金額（税込）' }))),
          el('tbody', {}, ...c.lines.map((l) => el('tr', {}, el('td', { text: l.label }), el('td', { class: 'r', text: yen(l.amount) }), el('td', { class: 'r', text: yen(l.payable - l.amount) }), el('td', { class: 'r', text: yen(l.payable) }))),
            c.fee ? el('tr', {}, el('td', { colSpan: 3, text: c.fee.label }), el('td', { class: 'r', text: yen(c.fee.amount) })) : null),
          el('tfoot', {}, el('tr', {}, el('td', { colSpan: 3, text: '合計' }), el('td', { class: 'r', text: yen(total) })))),
        el('p', { class: 'small', text: 'この紙は、同梱する品の一覧です。請求書・領収書では、ありません（請求書・領収書は、マイページから開けます）。届いた品に、まちがいや不足があるときは、上の連絡先まで、お知らせください。' }));
    }));
  } else {
    // 作業票（発注者の指示で、詰めた。報告書 132 章）: 顧客1人につき1行の表。A4 の横。30人が、1〜2枚に収まる。
    // 品は、チェックの欄つきで、1行の中に並べる。運送会社・伝票番号・個口は、手で書く欄（記録済みなら、その値）
    const done = (c) => c.lines.filter((l) => l.state === 'shipped');
    $('#sheet').replaceChildren(
      el('h1', { class: 'sheet__title' }, `梱包の作業票　${evLine}`, el('span', { text: `　${list.length}人・${list.reduce((n, c) => n + c.lines.length, 0)}点` })),
      el('table', { class: 'worktable' },
        el('thead', {}, el('tr', {}, ...[['済', 'c'], ['会員', 'c'], ['名前', ''], ['配送先・電話番号', ''], ['品（入れたら、印を付ける）', ''], ['送料', 'r'], ['運送会社', ''], ['伝票番号', ''], ['個口', 'c']].map(([t, cls]) => el('th', { class: cls, text: t })))),
        el('tbody', {}, ...list.map((c) => {
          const d = done(c), first = d[0];
          return el('tr', {},
            el('td', { class: 'c' }, el('span', { class: 'box', 'aria-hidden': 'true' })),
            el('td', { class: 'c no', text: String(c.accountId) }),
            el('td', { class: 'name', text: c.name }),
            el('td', { class: 'addr' }, `${c.zip ? '〒' + c.zip + ' ' : ''}${c.address}`, c.phone ? el('span', { class: 'tel', text: c.phone }) : null),
            el('td', { class: 'items' }, ...c.lines.map((l) => el('span', { class: `item${l.state === 'unpaid' ? ' item--wait' : ''}${l.state === 'shipped' ? ' item--done' : ''}` },
              el('span', { class: 'box box--s', 'aria-hidden': 'true' }), l.label, l.state === 'unpaid' ? el('i', { text: '（お支払い待ち）' }) : l.state === 'shipped' ? el('i', { text: '（済）' }) : null))),
            el('td', { class: 'r', text: c.fee ? yen(c.fee.amount) : '' }),
            el('td', { class: 'write', text: first ? carrierName(first.carrier) : '' }),
            el('td', { class: 'write write--long', text: first ? first.tracking : '' }),
            el('td', { class: 'write c' }));
        }))));
  }
})();
