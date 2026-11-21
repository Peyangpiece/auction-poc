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
  const carrierName = (key) => res.carriers.find((c) => c.key === key)?.name ?? '';
  const carrierField = (value = '') => field('運送会社', 'carrier', { options: [['', '（選ばない）'], ...res.carriers.map((c) => [c.key, c.name])], value });
  // お知らせメール: メールアドレスのある顧客にだけ、選ばせる。はじめは、送る
  const notifyField = (c, label = '発送のお知らせメールを、顧客へ送る') => (c.hasEmail
    ? el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'notify', checked: true }), el('span', { text: label }))
    : el('p', { class: 'note', text: 'メールアドレスの登録が無いので、お知らせメールは送りません。' }));
  const said = (r) => { if (r.ok && r.notifyFailed) alertLine('配送済みにしましたが、お知らせメールを送れませんでした。「記録」の知らせを確かめてください。'); return r; };
  const ship = (title, note, lines, c) => askForm(title, note,
    [carrierField(), field('伝票番号', 'tracking', { inputMode: 'numeric', autocomplete: 'off', placeholder: '例: 1234-5678-9012' }), field('メモ（任意）', 'memo', {}), notifyField(c)],
    async (d) => said(await api('POST', '/api/billing/shipping/ship', { lineIds: lines.map((l) => l.id), carrier: d.carrier, tracking: d.tracking, memo: d.memo, notify: d.notify === 'on' || d.notify === true })), '配送済みにする');
  // 印刷（宛名ラベル・納品書・作業票）: 別の画面で開く。顧客を選べば、その顧客だけ
  const printLink = (doc, text, accountId = null) => el('a', { class: 'btn', target: '_blank', rel: 'noopener', href: `/print.html?doc=${doc}&event=${res.event}${accountId ? `&account=${accountId}` : ''}${!accountId && shipFilter.state === 'open' ? '&only=open' : ''}`, text });
  const unship = (title, lines) => askReason(title, '取り消しの理由', true, (reason) => api('POST', '/api/billing/shipping/unship', { lineIds: lines.map((l) => l.id), reason }), '取り消す');

  const HEADS = ['', '会員番号', '顧客・配送先', '品', '状態', ''];
  const body = el('tbody', {});
  const empty = el('p', { class: 'empty' });
  const summary = el('p', { class: 'note', role: 'status' });
  const wrap = el('div', {}, el('div', { class: 'tablewrap' }, el('table', {},
    el('thead', {}, el('tr', {}, HEADS.map((h, i) => (h ? el('th', { scope: 'col', text: h }) : el('th', { scope: 'col' }, el('span', { class: 'sr-only', text: i === 0 ? '開く' : '操作' })))))), body)), empty);

  // 運送会社のシステムが出した「発行済みのデータ」（CSV。見出しの行つき）から、伝票番号を取り込む
  function importDialog() {
    const file = el('input', { class: 'input', type: 'file', accept: '.csv,text/csv', 'aria-label': '発行済みのデータ（CSV）', required: true });
    const form = el('form', { class: 'form', novalidate: true },
      el('p', { text: '運送会社のシステムで送り状を発行したあと、「発行済みのデータ」を、見出しの行つきの CSV で出力して、ここで選んでください。「お客様管理番号」と「伝票番号」の列を、見出しの名前で探します。' }),
      field('運送会社', 'carrier', { options: res.carriers.map((c) => [c.key, `${c.name}（${c.system}）`]) }),
      el('label', { class: 'field' }, el('span', { text: '発行済みのデータ（CSV）' }), file),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'notify', checked: true }), el('span', { text: '配送済みにした顧客へ、発送のお知らせメールを送る' })),
      msgLine(),
      el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '取り込む' }), closeBtn('やめる')));
    onSubmit(form, async (d) => {
      const f = file.files?.[0];
      if (!f) return { ok: false, message: 'ファイルを選んでください' };
      const buf = await f.arrayBuffer();
      // 文字コード: UTF-8 として読めなければ、Shift_JIS として読む（運送会社のシステムの設定で、どちらもありうる）
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('shift_jis').decode(buf); }
      const table = parseCsv(text.replace(/^\ufeff/, ''));
      const norm = (v) => String(v ?? '').normalize('NFKC').replace(/[\s　"']/g, '');
      // 見出しの行: 「お客様管理番号」を含む、最初の行
      const at = table.findIndex((r) => r.some((c) => norm(c).includes('お客様管理番号')));
      if (at < 0) return { ok: false, message: '「お客様管理番号」の列が、見つかりません。見出しの行を付けて、出力し直してください。' };
      const head = table[at].map(norm);
      const iRef = head.findIndex((n) => n.includes('お客様管理番号'));
      const iNo = head.findIndex((n) => n === '伝票番号' || n.includes('送り状No') || n.includes('送り状番号') || n.includes('伝票番号'));
      if (iNo < 0) return { ok: false, message: '伝票番号（お問い合せ送り状No.）の列が、見つかりません。' };
      const rows = table.slice(at + 1).map((r) => ({ ref: r[iRef], tracking: r[iNo] })).filter((r) => String(r.ref ?? '').trim());
      if (!rows.length) return { ok: false, message: '取り込む行が、ありません。' };
      const r = await api('POST', '/api/billing/shipping/import', { carrier: d.carrier, rows, notify: d.notify === 'on' });
      if (!r.ok) return r;
      dlg.close(); await show('shipping');
      openDialog('伝票番号を取り込みました',
        el('dl', { class: 'facts' },
          el('dt', { text: '配送済みにした' }), el('dd', { text: `${r.customers}人・${r.shipped}点` }),
          el('dt', { text: '伝票番号だけを入れた（すでに配送済み）' }), el('dd', { text: `${r.updated}点` }),
          el('dt', { text: 'お知らせメール' }), el('dd', { text: `${r.notified}通${r.notifyFailed ? `（送れなかった ${r.notifyFailed}通）` : ''}` })),
        r.unpaid.length ? el('p', { class: 'warn', text: `お支払いの確認が済んでいないので、配送済みにしなかった: ${r.unpaid.join('、')}` }) : null,
        r.noNumber.length ? el('p', { class: 'note', text: `伝票番号が空だった: ${r.noNumber.join('、')}` }) : null,
        r.unknown.length ? el('p', { class: 'note', text: `この画面の顧客と合わなかった管理番号: ${r.unknown.slice(0, 20).join('、')}${r.unknown.length > 20 ? ' ほか' : ''}` }) : null,
        el('div', { class: 'actions' }, closeBtn()));
      return { ok: false, message: '' };
    });
    openDialog('伝票番号を取り込む', form);
  }
  function render() {
    const q = shipFilter.q.trim().toLowerCase();
    const hit = res.customers.filter((c) => (!shipFilter.state || (shipFilter.state === 'open' ? c.state !== 'shipped' : c.state === shipFilter.state))
      && (!q || [String(c.accountId), c.name, c.address, c.phone, ...c.lines.map((l) => l.label)].some((v) => String(v ?? '').toLowerCase().includes(q))));
    const out = [];
    for (const c of hit) {
      const ready = c.lines.filter((l) => l.state === 'ready'), done = c.lines.filter((l) => l.state === 'shipped'), wait = c.lines.filter((l) => l.state === 'unpaid');
      const isOpen = shipOpen.has(c.accountId);
      const toggle = () => { if (isOpen) shipOpen.delete(c.accountId); else shipOpen.add(c.accountId); render(); };
      // 運送会社と伝票番号（品ごとに違うこともあるので、重なりを除いて並べる）
      const shipInfo = (l) => [carrierName(l.carrier), l.tracking, l.memo].filter(Boolean).join(' ');
      const memos = [...new Set(done.map(shipInfo).filter(Boolean))];
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
            `${ready.length}点: ${ready.map((l) => l.label).join('、')}${wait.length ? `。お支払い待ちの ${wait.length}点は、含みません。` : ''}`, ready, c), 'btn-primary'),
          smallBtn(isOpen ? '品をしまう' : `品ごとに見る（${c.lines.length}点）`, toggle),
          printLink('labels', '宛名ラベル', c.accountId), printLink('slips', '納品書', c.accountId), printLink('sheet', '作業票', c.accountId),
          admin && done.length > 0 && smallBtn('配送済みを取り消す', () => unship(`${c.name}さんの配送済み（${done.length}点）を取り消す`, done))));
      out.push(row);
      if (isOpen) out.push(...c.lines.map((l) => el('tr', { class: 'linerow' },
        el('td', {}), el('td', {}),
        el('td', { class: 'dyn', 'data-label': '品' }, el('div', { text: l.label })),
        el('td', { class: 'n', 'data-label': '落札額', text: yen(l.amount) }),
        el('td', { 'data-label': '状態' }, el('span', { class: l.state === 'unpaid' ? 'warn' : 'state', 'data-on': l.state === 'shipped' ? '1' : '0', text: SHIP_LINE[l.state] }),
          l.shippedOn ? el('div', { class: 'note', text: [jpDay(l.shippedOn), carrierName(l.carrier), l.tracking, l.memo].filter(Boolean).join('　') }) : null,
          l.trackingUrl ? el('div', {}, el('a', { class: 'textlink', href: l.trackingUrl, target: '_blank', rel: 'noopener', text: '配達の状況を見る' })) : null,
          l.shippedOn ? el('div', { class: 'note', text: l.notifiedOn ? `お知らせメール ${jpDay(l.notifiedOn)}` : 'お知らせメールは、送っていません' }) : null),
        act(
          l.state === 'ready' && smallBtn('この品を、配送済みにする', () => ship(`${c.name}さんへ配送済みにする`, l.label, [l], c), 'btn-primary'),
          l.state === 'shipped' && smallBtn('伝票番号を直す', () => askForm('運送会社・伝票番号を直す', l.label,
            [carrierField(l.carrier), field('伝票番号', 'tracking', { inputMode: 'numeric', autocomplete: 'off', value: l.tracking }), field('メモ（任意）', 'memo', { value: l.memo }),
              c.hasEmail ? el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'notify' }), el('span', { text: '直した内容で、発送のお知らせメールを、送り直す' })) : null].filter(Boolean),
            (d) => api('POST', '/api/billing/shipping/memo', { lineIds: [l.id], carrier: d.carrier, tracking: d.tracking, memo: d.memo, notify: d.notify === 'on' || d.notify === true }), '保存する')),
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
      res.event !== null && el('div', { class: 'toolbar__acts' },
        // 印刷は、上の「状態」で「まだ配送していない」を選んでいれば、その顧客だけ
        exportMenuNamed('印刷する', [printLink('labels', '宛名ラベル'), printLink('slips', '同梱する納品書'), printLink('sheet', '梱包の作業票')]),
        // 運送会社の送り状発行システムへ取り込むファイル。お支払いの確認が済んだ、未配送の顧客だけが入る
        admin && exportMenuNamed('運送会社へ', [
          ...res.carriers.flatMap((c) => [
            el('a', { class: 'btn', href: `/api/billing/shipping/carrier.csv?event=${res.event}&carrier=${c.key}&form=standard`, text: `${c.name}（${c.system}）へ取り込むファイル` }),
            el('a', { class: 'btn', href: `/api/billing/shipping/carrier.csv?event=${res.event}&carrier=${c.key}&form=simple`, text: `${c.name}: 項目名つきの簡単な形` })]),
          smallBtn('伝票番号を取り込む…', importDialog)]),
        admin && exportMenu([el('a', { class: 'btn', href: `/api/billing/shipping.csv?event=${res.event}`, text: '配送の一覧（この開催・CSV）' })]))),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    el('div', { class: 'filters', role: 'search', 'aria-label': '配送の絞り込み' },
      pick('開催', 'event', evOptions.length ? evOptions : [['', '（配送の品のある開催は、まだありません）']]),
      el('label', { class: 'filter filter--wide' }, el('span', { text: '顧客・品' }), search),
      pick('状態', 'state', [['', 'すべて'], ['open', 'まだ配送していない（未配送・一部・お支払い待ち）'], ['ready', '未配送'], ['partial', '一部を配送済み'], ['shipped', '配送済み'], ['unpaid', 'お支払い待ち']])),
    summary, wrap];
}

/** CSV を、行と列に分ける（値の中の、カンマ・改行・二重引用符に対応） */
function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
