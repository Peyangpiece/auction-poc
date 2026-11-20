// 管理画面: 請求（精算・消し込み・引き渡し・未払い・手数料）（報告書 122 章で、staff.js から分けた。読み込む順番は staff.html のとおり。名前は、ファイルをまたいで共有する）
'use strict';

// ------------------------------------------------------------ 請求: 精算・消し込み・引き渡し・未払いの対応・請求書
const LINE_STATE = { unsettled: '未精算', billed: '請求済み', unpaid: '未払い', cleared: '消し込み済み', delivered: '引き渡し済み', cancelled: '解除' };
const INV_KIND = { cash: '現金の精算', transfer: '振込', promote: '繰り上げ', penalty: '違約金など' };
const isAdmin = () => me.role === 'admin';
// 送料: 金額と内容（運送会社・大きさなど）を、あとから手で入れる。まだ送っていない請求書があれば、その請求書に足す
const shippingForm = (accountId, eventId, name, now = null) => askForm('送料を入力', `${name}。金額は、あとから直せます（請求書を「送付済み」にするまで）。0円で、送料の行を消します。`,
  [field('送料（円・税込）', 'amount', { inputMode: 'numeric', required: true, value: now?.amount ?? '' }), field('内容', 'label', { value: (now?.label ?? '').replace('【送料】', ''), placeholder: 'ヤマト運輸 120サイズ' }, '請求書に「【送料】」に続けて載ります')],
  (d) => api('POST', '/api/billing/shipping', { accountId, eventId, amount: Number(d.amount), label: d.label }), '請求書に反映する');
// 認証アプリに読み取らせる QR コード（画像として出す）
// パスワードや鍵は、ブラウザの自動翻訳で書き換えられないようにする
const noTranslate = (node) => { node.setAttribute('translate', 'no'); return node; };
const qrImg = (svg) => el('img', { class: 'qr', alt: '認証アプリ用の QR コード', width: 200, height: 200, src: 'data:image/svg+xml;base64,' + btoa(svg) });
const secretsDialog = (title, res) => openDialog(title,
  el('p', { text: '次の内容は、この画面を閉じると二度と表示できません。本人に、安全な方法で渡してください。' }),
  el('dl', { class: 'facts' },
    el('dt', { text: 'ログイン ID' }), el('dd', { text: res.loginId }),
    el('dt', { text: '仮のパスワード' }), el('dd', {}, noTranslate(el('div', { class: 'secret', text: res.initialPassword }))),
    el('dt', { text: '認証アプリの鍵' }), el('dd', {}, noTranslate(el('div', { class: 'secret', text: res.totpSecret })))),
  qrImg(res.qrSvg),
  el('p', { class: 'note', text: '認証アプリで読み取ってください' }),
  el('div', { class: 'actions' }, closeBtn('渡したので閉じる')));
const post = async (url, body) => { const r = await api('POST', url, body); if (!r.ok) alertLine(r.message); show(current); return r; };
/** 入力を1つ（または2つ）聞いてから実行する */
function askForm(title, note, fields, run, okText = '実行する') {
  const form = el('form', { class: 'form', novalidate: true }, note && el('p', { text: note }), fields, msgLine(),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: okText }), closeBtn('やめる')));
  onSubmit(form, async (data) => { const res = await run(data); if (res.ok) { dlg.close(); show(current); } return res; });
  openDialog(title, form);
}
async function billingPanel() {
  const res = await api('GET', withLimit('/api/billing/lines', 'lines'));
  if (!res.ok) return [el('p', { class: 'msg', text: res.message })];
  const picked = new Set();
  const settleBtn = smallBtn('選んだ明細を、当日現金で精算', async () => {
    const r = await api('POST', '/api/billing/settle', { lineIds: [...picked] });
    if (!r.ok) return alertLine(r.message);
    show('billing');
    openDialog('精算しました', el('p', { text: `請求書（領収書を兼ねる）${r.invoice.number} を発行しました。金額 ${yen(r.invoice.total)}` }),
      el('div', { class: 'actions' }, el('a', { class: 'btn btn-primary', href: `/api/billing/invoices/${r.invoice.id}/pdf`, text: 'PDF を開く' }), closeBtn()));
  }, 'btn-primary');
  // 押せない大きなボタンを先に見せない。明細を選ぶと「○件を当日現金で精算」が出る
  settleBtn.hidden = true;
  const syncSettle = () => { settleBtn.hidden = picked.size === 0; settleBtn.textContent = `${picked.size}件を、当日現金で精算`; };
  const rows = res.lines.map((l) => {
    const box = l.state === 'unsettled' && el('input', { type: 'checkbox', 'aria-label': `${l.label} を精算に選ぶ`, onchange: (ev) => { if (ev.target.checked) picked.add(l.id); else picked.delete(l.id); syncSettle(); } });
    const a = isAdmin();
    return el('tr', {},
      el('td', {}, box || ''),
      el('td', { class: 'n paddle', text: l.paddle ?? '' }),
      el('td', { class: 'dyn' }, l.name, el('div', { class: 'note', text: l.label })),
      // 払う金額は、落札額＋買歩銭
      el('td', { class: 'n' }, yen(l.payable), l.premium ? el('div', { class: 'note', text: `落札 ${yen(l.amount)}＋買歩銭 ${yen(l.premium)}` }) : null),
      el('td', { text: `${RECV[l.receive] ?? ''}${l.payment ? '・' + PAY[l.payment] : ''}` }),
      el('td', {}, el('span', { class: l.state === 'unpaid' ? 'warn' : 'state', 'data-on': ['cleared', 'delivered'].includes(l.state) ? '1' : '0', text: LINE_STATE[l.state] }),
        l.invoice && el('div', { class: 'note', text: `${l.invoice.number}${l.invoice.dueDate ? '　期限 ' + jpDay(l.invoice.dueDate) : ''}` }),
        l.pickupBy && l.state === 'cleared' && el('div', { class: l.pickupLate ? 'warn' : 'note', text: `受け取り期限 ${jpDay(l.pickupBy)}` }),
        l.offer && el('div', { class: 'note', text: `繰り上げ: ${{ open: '回答待ち', accepted: '承諾', declined: '辞退', expired: '期限切れ' }[l.offer.state]}` })),
      act(
        // 消し込み: 入金の日と方法（振込・現金）を入れる。受付係は、現金の受け取りだけ（本番運用の評価 C）
        ['billed', 'unpaid'].includes(l.state) && smallBtn(a ? '入金を記録' : '現金を受け取った', () => askForm(a ? '入金の記録（消し込み）' : '現金の受け取り', `${l.name}　${l.label}。受け取った金額が、明細の金額（${yen(l.payable)}${l.premium ? '。買歩銭を含む' : ''}）と一致するときだけ記録できます。`,
          [field('受け取った金額（円）', 'amount', { inputMode: 'numeric', required: true }),
            field('入金の日', 'paidOn', { type: 'date', value: todayStr(), max: todayStr(), required: true }, '振込なら、通帳・明細に載っている日'),
            a ? field('方法', 'method', { options: [['transfer', '銀行振込'], ['cash', '現金']] }) : null,
            field('メモ', 'memo', {}, '任意')].filter(Boolean),
          (d) => api('POST', `/api/billing/lines/${l.id}/clear`, { amount: Number(d.amount), paidOn: d.paidOn, method: a ? d.method : 'cash', memo: d.memo }), '記録する'), 'btn-primary'),
        a && l.state === 'unpaid' && smallBtn('督促', () => askForm('督促の記録', l.dunning.map((d) => `${dateFmt.format(d.at)} ${d.method}: ${d.body}`).join('\n'),
          [field('方法', 'method', { required: true, placeholder: '電話・メールなど' }), field('内容', 'body', { rows: 3, required: true })], (d) => api('POST', `/api/billing/lines/${l.id}/dun`, d), '記録する')),
        a && l.state === 'unpaid' && smallBtn('解除…', () => askReason('落札を解除', '解除の理由', true, (reason) => api('POST', `/api/billing/lines/${l.id}/cancel`, { reason }), '解除する'), 'btn-danger'),
        l.state === 'cleared' && l.kind !== 'penalty' && l.kind !== 'late' && smallBtn('引き渡し', () => confirmDo(`${l.name}さんに引き渡しますか？`, `${l.label}。引き渡しの記録を残します（取り消しは主催者管理者だけができます）。`, '引き渡す', () => api('POST', `/api/billing/lines/${l.id}/deliver`)), 'btn-primary'),
        a && l.state === 'cleared' && smallBtn('消し込みを取り消す', () => askReason('消し込みを取り消す', '取り消しの理由', true, (reason) => api('POST', `/api/billing/lines/${l.id}/unclear`, { reason }), '取り消す')),
        a && l.state === 'delivered' && smallBtn('引き渡しを取り消す', () => askReason('引き渡しの記録を取り消す', '取り消しの理由', true, (reason) => api('POST', `/api/billing/lines/${l.id}/undeliver`, { reason }), '取り消す')),
        a && l.state === 'cancelled' && l.kind === 'lot' && !l.offer && smallBtn('繰り上げを打診', () => confirmDo('次点の人に、繰り上げを打診しますか？', `${l.label}。次点の人に、繰り上げ落札のご案内をメールで送ります（回答の期限は3日後）。打診できるのは1人だけで、取り消せません。`, '打診する', () => api('POST', `/api/billing/lines/${l.id}/offer`))),
        a && ['lot', 'promote'].includes(l.kind) && l.receive === 'ship' && l.state !== 'cancelled' && smallBtn('送料', () => shippingForm(l.accountId, l.eventId, l.name)),
        // 違約金・遅延損害金: 設定の率から計算した案を初めに入れておく。金額は、確かめてから確定する
        ...(a && l.state === 'cancelled' || a && ['cleared', 'delivered'].includes(l.state) && l.invoice?.dueDate && l.clearedOn > l.invoice.dueDate ? [l.state === 'cancelled' ? ['penalty', '違約金'] : ['late', '遅延損害金']].map(([kind, name]) => smallBtn(name, async () => {
          const hint = await api('GET', `/api/billing/lines/${l.id}/penalty-suggest?kind=${kind}`);
          askForm(`${name}の請求`, `金額を確かめて、確定してください。別の請求書を発行します。${hint.basis ? `（${hint.basis}）` : ''}`,
            [field('金額（円）', 'amount', { inputMode: 'numeric', required: true, value: hint.amount ?? '' })], (d) => api('POST', `/api/billing/lines/${l.id}/penalty`, { kind, amount: Number(d.amount) }), '請求書を発行');
        })) : []),
        a && ['cancelled', 'cleared', 'delivered'].includes(l.state) && smallBtn('返金', () => askForm('返金の記録', `${l.name}　${l.label}`,
          [field('返金額（円）', 'amount', { inputMode: 'numeric', required: true }), field('返金日', 'date', { type: 'date', value: res.today, required: true }),
            field('方法', 'method', { options: [['transfer', '振込'], ['cash', '現金']] }), field('理由', 'reason', { rows: 2, required: true })], (d) => api('POST', `/api/billing/lines/${l.id}/refund`, { ...d, amount: Number(d.amount) }), '記録する'))));
  });
  const nodes = [
    // 書き出しは、月に一度ほどの作業なので、ひとつの「書き出す」の中にまとめる（報告書 83 章）
    el('div', { class: 'toolbar' }, el('div', { class: 'toolbar__acts' }, settleBtn), isAdmin() && exportMenu([
      el('a', { class: 'btn', href: '/api/billing/shipping.csv', text: '配送の一覧（CSV）' }),
      el('a', { class: 'btn', href: `/api/billing/ledger.csv?month=${res.today.slice(0, 7)}`, text: '帳簿用の記録（CSV）' }),
      el('a', { class: 'btn', href: `/api/billing/invoices.xlsx?month=${res.today.slice(0, 7)}`, text: '請求書の一覧（Excel）' })])),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    table(['', '参加番号', '落札者・品', '金額', '受け取り・支払', '状態', ''], rows, '落札した品は、まだありません。'),
    moreBtn('lines', res, '落札の明細'),
  ];
  if (isAdmin()) {
    const inv = await api('GET', withLimit('/api/billing/invoices', 'invoices'));
    nodes.push(el('h2', { class: 'subhead', text: '請求書' }),
      table(['請求番号', '宛先', '種類', '金額', '発行日', '送付・期限', ''], inv.invoices.map((i) => el('tr', {},
        el('td', { class: 'n', text: i.number }), el('td', { class: 'dyn', text: i.name }), el('td', { text: INV_KIND[i.kind] }), el('td', { class: 'n' }, i.cancelled ? [yen(i.total), el('br'), el('span', { class: 'note', text: `発行時 ${yen(i.issuedTotal)}・解除 ${i.cancelled}件` })] : yen(i.total)), el('td', { class: 'n', text: jpDay(i.issuedOn) }),
        el('td', {}, i.void ? el('span', { class: 'warn', text: '精算を取り消した（無効）' }) : i.kind === 'cash' ? 'その場で渡した' : el('span', { class: !i.sentOn && i.stale ? 'warn' : '', text: `${i.sentOn ? `送付 ${jpDay(i.sentOn)}` : i.draft === 'failed' ? '未送付（下書きの作成に失敗）' : '未送付'}　期限 ${jpDay(i.dueDate)}` })),
        act(el('a', { class: 'btn', href: `/api/billing/invoices/${i.id}/pdf`, text: 'PDF' }), el('a', { class: 'btn', href: `/api/billing/invoices/${i.id}/xlsx`, text: 'Excel' }),
          !['cash', 'penalty'].includes(i.kind) && !i.sentOn && smallBtn(i.shipping ? `送料 ${yen(i.shipping.amount)}` : '送料を入力', () => shippingForm(i.accountId, i.eventId, i.name, i.shipping)),
          i.kind !== 'cash' && !i.sentOn && smallBtn('メールの文面', async () => {
            const m = await api('GET', `/api/billing/invoices/${i.id}/mail`);
            if (!m.ok) return alertLine(m.message);
            const text = el('textarea', { class: 'input', rows: 14, readonly: true, 'aria-label': '本文' }); text.value = m.body;
            const copied = el('span', { class: 'note', role: 'status' });
            openDialog('請求メールの文面', el('p', { class: 'note', text: 'PDF を添えて、ご自分のメールから送ってください。送ったら「送付済みにする」を押します。' }),
              el('dl', { class: 'facts' }, el('dt', { text: '宛先' }), el('dd', { class: 'dyn', text: m.to || '（メールアドレスの登録なし）' }), el('dt', { text: '件名' }), el('dd', { class: 'dyn', text: m.subject })),
              text,
              el('div', { class: 'actions' },
                smallBtn('本文を写す', async () => { try { await navigator.clipboard.writeText(m.body); copied.textContent = '写しました'; } catch { text.select(); copied.textContent = '選びました。コピーしてください'; } }, 'btn-primary'),
                m.to && el('a', { class: 'btn', href: `mailto:${encodeURIComponent(m.to)}?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.body)}`, text: 'メールソフトで開く' }),
                closeBtn(), copied));
          }),
          i.kind !== 'cash' && (i.sentOn ? smallBtn('送付を取り消す', () => post(`/api/billing/invoices/${i.id}/unsent`)) : smallBtn('送付済みにする', () => post(`/api/billing/invoices/${i.id}/sent`), 'btn-primary'))))), '請求書は、まだありません。'),
      moreBtn('invoices', inv, '請求書の一覧'));
  }
  return nodes;
}
async function pickupPanel() {
  const res = await api('GET', '/api/billing/pickup');
  return [table(['落札者', '品', '消し込み', '受け取り期限'], res.lines.map((l) => el('tr', {},
      el('td', { class: 'dyn', text: l.name }), el('td', { class: 'dyn', text: l.label }), el('td', { class: 'n', text: jpDay(l.clearedOn) }),
      el('td', {}, el('span', { class: l.pickupLate ? 'warn' : 'n', text: `${jpDay(l.pickupBy)}${l.pickupLate ? '（期限を過ぎています）' : ''}` })))), '未引き取りの品はありません。')];
}
let feeMonth = null;
async function feesPanel() {
  const [f, long] = await Promise.all([api('GET', '/api/billing/fees' + (feeMonth ? `?month=${feeMonth}` : '')), api('GET', '/api/billing/long-unpaid')]);
  feeMonth = f.month;
  const pick = el('input', { class: 'input', type: 'month', value: f.month, 'aria-label': '月', onchange: (ev) => { feeMonth = ev.target.value; show('fees'); } });
  return [
    el('div', { class: 'toolbar' }, el('div', { class: 'monthpick' }, pick),
      f.confirmedOn ? el('p', { text: `確認済み（${jpDay(f.confirmedOn)}）` }) : isAdmin() && smallBtn('この月の明細を、確認済みにする', () => confirmDo(`${f.month.slice(0, 4)}年${Number(f.month.slice(5))}月の明細を、確認済みにしますか？`, '確認済みにすると、取り消せません。金額を確かめてから押してください。', '確認済みにする', () => api('POST', '/api/billing/fees/confirm', { month: f.month })), 'btn-primary')),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    el('dl', { class: 'facts' },
      el('dt', { text: '対象の落札額（消し込み済み・税込）' }), el('dd', { class: 'n', text: yen(f.base) }),
      el('dt', { text: `手数料（${f.rate}%。差し引き ${yen(f.deduction)}${f.carriedIn ? `、前の月からの繰り越し ${yen(f.carriedIn)}` : ''}）` }), el('dd', { class: 'n', text: yen(f.fee) }),
      ...(f.carriedOut ? [el('dt', { text: '引ききれなかった分（次の月へ繰り越し）' }), el('dd', { class: 'n', text: yen(f.carriedOut) })] : []),
      el('dt', { text: '最低保証額' }), el('dd', { class: 'n', text: yen(f.minimum) }),
      el('dt', { text: `消費税（${f.taxMode === 'exclusive' ? '外税' : '内税'}）` }), el('dd', { class: 'n', text: f.taxMode === 'exclusive' ? yen(f.tax) : '手数料に含む' }),
      el('dt', { text: '請求額' }), el('dd', { class: 'n paddle', text: yen(f.total) })),
    el('h2', { class: 'subhead', text: '根拠になる明細' }),
    table(['品', '税込落札額', '支払方法', '消し込みの日', '返金・取り消し'], f.details.map((d) => el('tr', {},
      el('td', { class: 'dyn', text: d.label }), el('td', { class: 'n', text: yen(Math.abs(d.amount)).replace('¥', d.amount < 0 ? '−¥' : '¥') }), el('td', { text: d.method ?? '' }), el('td', { class: 'n', text: jpDay(d.clearedOn) }), el('td', { text: d.note }))), 'この月の明細はありません。'),
    el('h2', { class: 'subhead', text: '長く未払いのままの明細（期限の翌日から30日以上）' }),
    table(['落札者', '品', '金額', '期限', '督促', '引き渡し'], long.lines.map((l) => el('tr', {},
      el('td', { class: 'dyn', text: l.name }), el('td', { class: 'dyn', text: l.label }), el('td', { class: 'n', text: yen(l.amount) }), el('td', { class: 'n', text: jpDay(l.invoice.dueDate) }),
      el('td', { text: `${l.dunning.length} 回` }), el('td', { text: l.deliveredOn ? '済' : '未' }))), '該当する明細はありません。'),
  ];
}
