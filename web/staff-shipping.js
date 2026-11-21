// 管理画面: 配送（発注者の指示。報告書 130 章）。開催ごとに、配送を選んだ品を、顧客ごとに1行で出し、配送済み・未配送を管理する。
// 基本は、顧客ごとにまとめて記録する。行を開くと、品ごとにも記録できる。読み込む順番は staff.html のとおり
'use strict';

const shipFilter = { event: '', state: '', q: '' };
const shipOpen = new Set(); // 品ごとの明細を開いている顧客（会員番号）
const SHIP_STATE = { shipped: '配送済み', partial: '一部を配送済み', ready: '未配送', unpaid: 'お支払い待ち' };
const SHIP_LINE = { shipped: '配送済み', ready: '未配送', unpaid: 'お支払い待ち' };

async function shippingPanel() {
  const res = await api('GET', `/api/billing/shipping${shipFilter.event ? `?event=${encodeURIComponent(shipFilter.event)}` : ''}`);
  if (!res.ok) return [el('p', { class: 'msg', text: res.message })];
  shipFilter.event = res.event === null ? '' : String(res.event);
  const admin = isAdmin();
  // 記録する: 伝票番号などのメモを聞いてから、選んだ品を、まとめて配送済みにする（全部できるか、何もしないか）
  const ship = (title, note, lines) => askForm(title, note,
    [field('伝票番号・運送会社など（任意）', 'memo', { placeholder: '例: ヤマト 1234-5678-9012' })],
    (d) => api('POST', '/api/billing/shipping/ship', { lineIds: lines.map((l) => l.id), memo: d.memo }), '配送済みにする');
  const unship = (title, lines) => askReason(title, '取り消しの理由', true, (reason) => api('POST', '/api/billing/shipping/unship', { lineIds: lines.map((l) => l.id), reason }), '取り消す');

  const HEADS = ['', '会員番号', '顧客・配送先', '品', '状態', ''];
  const body = el('tbody', {});
  const empty = el('p', { class: 'empty' });
  const summary = el('p', { class: 'note', role: 'status' });
  const wrap = el('div', {}, el('div', { class: 'tablewrap' }, el('table', {},
    el('thead', {}, el('tr', {}, HEADS.map((h, i) => (h ? el('th', { scope: 'col', text: h }) : el('th', { scope: 'col' }, el('span', { class: 'sr-only', text: i === 0 ? '開く' : '操作' })))))), body)), empty);

  function render() {
    const q = shipFilter.q.trim().toLowerCase();
    const hit = res.customers.filter((c) => (!shipFilter.state || (shipFilter.state === 'open' ? c.state !== 'shipped' : c.state === shipFilter.state))
      && (!q || [String(c.accountId), c.name, c.address, c.phone, ...c.lines.map((l) => l.label)].some((v) => String(v ?? '').toLowerCase().includes(q))));
    const out = [];
    for (const c of hit) {
      const ready = c.lines.filter((l) => l.state === 'ready'), done = c.lines.filter((l) => l.state === 'shipped'), wait = c.lines.filter((l) => l.state === 'unpaid');
      const isOpen = shipOpen.has(c.accountId);
      const toggle = () => { if (isOpen) shipOpen.delete(c.accountId); else shipOpen.add(c.accountId); render(); };
      const memos = [...new Set(done.map((l) => l.memo).filter(Boolean))];
      const row = el('tr', { class: 'memberrow shiprow', 'data-account': String(c.accountId) },
        el('td', {}, el('button', { class: 'btn expander', type: 'button', 'aria-expanded': String(isOpen), 'aria-label': `${c.name}さんの品を${isOpen ? 'しまう' : '開く'}`, onclick: toggle }, el('span', { 'aria-hidden': 'true', text: isOpen ? '▾' : '▸' }))),
        el('td', { class: 'n paddle', text: String(c.accountId) }),
        el('td', { class: 'dyn' }, el('b', { text: c.name }),
          el('div', { class: 'note', text: `${c.zip ? '〒' + c.zip + '　' : ''}${c.address || '（住所の登録なし）'}` }),
          c.phone ? el('div', { class: 'note', text: c.phone }) : null),
        el('td', {}, `${c.lines.length}点（配送済み ${done.length}）`,
          c.fee ? el('div', { class: 'note', text: `送料 ${yen(c.fee.amount)}　${c.fee.label.replace(/^【送料】\s*/, '')}` }) : el('div', { class: 'note', text: '送料は、まだ入れていません' })),
        el('td', {}, el('span', { class: c.state === 'unpaid' ? 'warn' : 'state', 'data-on': c.state === 'shipped' ? '1' : '0', text: SHIP_STATE[c.state] }),
          wait.length && c.state !== 'unpaid' ? el('div', { class: 'note', text: `お支払い待ち ${wait.length}点` }) : null,
          memos.length ? el('div', { class: 'note', text: memos.join('／') }) : null,
          done.length ? el('div', { class: 'note', text: `配送 ${[...new Set(done.map((l) => jpDay(l.shippedOn)))].join('・')}` }) : null),
        act(
          ready.length > 0 && smallBtn(done.length || wait.length ? `残り ${ready.length}点を、配送済みにする` : '配送済みにする', () => ship(`${c.name}さんへ配送済みにする`,
            `${ready.length}点: ${ready.map((l) => l.label).join('、')}${wait.length ? `。お支払い待ちの ${wait.length}点は、含みません。` : ''}`, ready), 'btn-primary'),
          smallBtn(isOpen ? '品をしまう' : `品ごとに見る（${c.lines.length}点）`, toggle),
          admin && done.length > 0 && smallBtn('配送済みを取り消す', () => unship(`${c.name}さんの配送済み（${done.length}点）を取り消す`, done))));
      out.push(row);
      if (isOpen) out.push(...c.lines.map((l) => el('tr', { class: 'linerow' },
        el('td', {}), el('td', {}),
        el('td', { class: 'dyn', 'data-label': '品' }, el('div', { text: l.label })),
        el('td', { class: 'n', 'data-label': '落札額', text: yen(l.amount) }),
        el('td', { 'data-label': '状態' }, el('span', { class: l.state === 'unpaid' ? 'warn' : 'state', 'data-on': l.state === 'shipped' ? '1' : '0', text: SHIP_LINE[l.state] }),
          l.shippedOn ? el('div', { class: 'note', text: `${jpDay(l.shippedOn)}${l.memo ? '　' + l.memo : ''}` }) : null),
        act(
          l.state === 'ready' && smallBtn('この品を、配送済みにする', () => ship(`${c.name}さんへ配送済みにする`, l.label, [l]), 'btn-primary'),
          l.state === 'shipped' && smallBtn('伝票番号を直す', () => askForm('伝票番号・運送会社などを直す', l.label, [field('伝票番号・運送会社など', 'memo', { value: l.memo })], (d) => api('POST', '/api/billing/shipping/memo', { lineIds: [l.id], memo: d.memo }), '保存する')),
          admin && l.state === 'shipped' && smallBtn('取り消す', () => unship(`「${l.label}」の配送済みを取り消す`, [l]))))));
    }
    labelCells(HEADS, out.filter((tr) => tr.classList.contains('memberrow')));
    body.replaceChildren(...out);
    wrap.firstChild.hidden = !hit.length;
    empty.hidden = !!hit.length;
    empty.textContent = res.customers.length ? 'この条件に合う顧客は、いません。' : res.events.length ? 'この開催には、配送の品は、ありません。' : '配送の品は、まだありません。';
    const n = (st) => res.customers.filter((c) => c.state === st).length;
    summary.textContent = res.customers.length ? `${res.customers.length}人　配送済み ${n('shipped')}人・一部 ${n('partial')}人・未配送 ${n('ready')}人・お支払い待ち ${n('unpaid')}人` : '';
  }
  const pick = (label, key, options) => {
    const sel = el('select', { class: 'input', 'aria-label': label, onchange: (ev) => { shipFilter[key] = ev.target.value; if (key === 'event') show('shipping'); else render(); } }, options.map(([value, text]) => el('option', { value, text })));
    sel.value = shipFilter[key];
    return el('label', { class: 'filter' }, el('span', { text: label }), sel);
  };
  const search = el('input', { class: 'input', type: 'search', placeholder: '会員番号・名前・住所・品名', 'aria-label': '会員番号・名前・住所・品名で探す', value: shipFilter.q, oninput: (ev) => { shipFilter.q = ev.target.value; render(); } });
  const evOptions = res.events.map((e) => [String(e.id), `${jpDay(e.date)}　${e.title}（${e.lines}点${e.open ? `・未配送 ${e.open}点` : '・すべて配送済み'}）`]);
  render();
  return [
    el('div', { class: 'toolbar' }, el('div', { class: 'toolbar__acts' }),
      admin && res.event !== null && exportMenu([el('a', { class: 'btn', href: `/api/billing/shipping.csv?event=${res.event}`, text: '配送の一覧（この開催・CSV）' })])),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    el('div', { class: 'filters', role: 'search', 'aria-label': '配送の絞り込み' },
      pick('開催', 'event', evOptions.length ? evOptions : [['', '（配送の品のある開催は、まだありません）']]),
      el('label', { class: 'filter filter--wide' }, el('span', { text: '顧客・品' }), search),
      pick('状態', 'state', [['', 'すべて'], ['open', 'まだ配送していない（未配送・一部・お支払い待ち）'], ['ready', '未配送'], ['partial', '一部を配送済み'], ['shipped', '配送済み'], ['unpaid', 'お支払い待ち']])),
    summary, wrap];
}
