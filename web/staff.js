// スタッフ用の管理画面: 受付（来場確認）、開催、会員、スタッフ、設定、記録。商品の登録は、進行コンソールで競りの最中に行う。
// どの操作ができるかは、サーバーが役割で決める。ここでは、できない操作の入口を出さないだけ。
'use strict';

const toConsole = new URLSearchParams(location.search).get('next') === 'console';
const toMonitor = new URLSearchParams(location.search).get('next') === 'monitor';
const dlg = $('#dlg');
const panel = $('#panel');
let me = null;
let current = null;

function openDialog(title, ...body) {
  dlg.replaceChildren(el('h2', { text: title }), ...body.filter(Boolean));
  if (!dlg.open) dlg.showModal();
}
const closeBtn = (text = '閉じる') => el('button', { class: 'btn', type: 'button', text, onclick: () => dlg.close() });
const msgLine = () => el('p', { class: 'msg', role: 'alert', tabIndex: -1 });
function table(heads, rows, empty) {
  if (!rows.length) return el('p', { class: 'empty', text: empty });
  return el('div', { class: 'tablewrap' }, el('table', {},
    // 見出しのない列（選ぶ印・操作のボタン）にも、読み上げ用の名前を付ける
    el('thead', {}, el('tr', {}, heads.map((h, i) => (h ? el('th', { scope: 'col', text: h }) : el('th', { scope: 'col' }, el('span', { class: 'sr-only', text: i === 0 ? '選択' : '操作' })))))),
    el('tbody', {}, rows)));
}
const act = (...buttons) => el('td', { class: 'act' }, buttons);
const smallBtn = (text, onclick, cls = '') => el('button', { class: `btn ${cls}`, type: 'button', text, onclick });
/** 理由を聞いてから実行する、取り消しにくい操作 */
function askReason(title, label, required, run) {
  const form = el('form', { class: 'form', novalidate: true },
    field(label, 'reason', { rows: 3, required }), msgLine(),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '実行する' }), closeBtn('やめる')));
  onSubmit(form, async (data) => {
    const res = await run(data.reason);
    if (res.ok) { dlg.close(); show(current); }
    return res;
  });
  openDialog(title, form);
  form.elements.reason.focus();
}

const alertLine = (text) => { const line = $('#line'); if (line) line.textContent = text; };

// ------------------------------------------------------------ 開催
async function eventsPanel() {
  const res = await api('GET', '/api/events');
  const rows = res.events.map((e) => el('tr', {},
    el('td', { class: 'dyn', text: e.title }),
    el('td', { class: 'n', text: `${jpDay(e.startsAt)} ${e.startsAt.slice(11)} 〜 ${e.endsAt.slice(11)}` }),
    el('td', { class: 'dyn', text: e.venueName }),
    el('td', { text: e.notified ? '届出済み' : '未届出' }),
    el('td', {}, el('span', { class: 'state', 'data-on': e.status === 'published' ? '1' : '0', text: e.status === 'published' ? '公開中' : '準備中' })),
    act(smallBtn('編集', () => eventDialog(e)),
      e.status !== 'published' && smallBtn('公開する', async () => { const r = await api('POST', `/api/events/${e.id}/publish`); if (!r.ok) alertLine(r.message); else show('events'); }, 'btn-primary'))));
  return [
    el('div', { class: 'toolbar' }, el('p', { class: 'note', text: '公開した開催が、トップページのカレンダーに出ます。届出済みの印がない開催は、公開できません。' }), smallBtn('開催を作る', () => eventDialog(null), 'btn-primary')),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    table(['名前', '日時', '会場', '届出', '状態', ''], rows, '開催はまだありません。'),
  ];
}
function eventDialog(e) {
  const v = e ?? { title: '', startsAt: '', endsAt: '', venueName: '', venueAddress: '', highlights: '', notified: false };
  const form = el('form', { class: 'form', novalidate: true },
    field('開催の名前', 'title', { value: v.title, required: true }),
    el('div', { class: 'grid2' },
      field('開始', 'startsAt', { type: 'datetime-local', value: v.startsAt, required: true }),
      field('終了', 'endsAt', { type: 'datetime-local', value: v.endsAt, required: true })),
    field('会場の名称', 'venueName', { value: v.venueName, required: true }),
    field('会場の住所', 'venueAddress', { value: v.venueAddress, required: true }),
    field('目玉商品', 'highlights', { value: v.highlights, rows: 4 }, '1行に1つ。開催の当日、トップページに「本日の目玉商品」として表示します'),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'notified', value: '1', checked: v.notified }), el('span', { text: '公安委員会への届出が済んでいる' })),
    msgLine(),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '保存する' }), closeBtn()));
  onSubmit(form, async (data) => {
    const res = await api('POST', e ? `/api/events/${e.id}` : '/api/events', { ...data, notified: data.notified === '1' });
    if (res.ok) { dlg.close(); show('events'); }
    return res;
  });
  openDialog(e ? '開催の編集' : '開催を作る', form);
}

// ------------------------------------------------------------ 会員
// 写し取るボタン（手で打ち直すと、まちがえやすい）
function copyBtn(text) {
  const b = el('button', { class: 'btn copybtn', type: 'button', text: 'コピー' });
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); b.textContent = 'コピーしました'; } catch { b.textContent = 'コピーできません'; }
    setTimeout(() => { b.textContent = 'コピー'; }, 2000);
  });
  return b;
}
// ログイン ID とパスワードを発行したあとの知らせ。メールで送った旨を出す。お試し用の設定のときだけ、内容も出す
function issuedDialog(title, res) {
  openDialog(title,
    res.devPassword
      ? el('p', { text: `ログイン ID とパスワードを発行しました。下の内容を、${res.name ?? '本人'}にお伝えください（お試し用の設定では、メールは送られません）。` })
      : res.sent === false
      ? el('p', { class: 'warn', role: 'alert', text: `${res.email} へのメールを、送れませんでした。少し待ってから、会員の一覧の「ログイン情報を発行」で、送り直してください。` })
      : el('p', { text: `ログイン ID とパスワードを、${res.email} へメールで送りました。` }),
    res.devPassword && el('dl', { class: 'facts' },
      el('dt', { text: 'ログイン ID' }), el('dd', { class: 'copyrow' }, noTranslate(el('div', { class: 'secret', text: res.loginId })), copyBtn(res.loginId)),
      el('dt', { text: 'パスワード' }), el('dd', { class: 'copyrow' }, noTranslate(el('div', { class: 'secret', text: res.devPassword })), copyBtn(res.devPassword))),
    res.devPassword && el('p', { class: 'note', text: '【お試し用】メールの送信サービスをつなぐ前なので、ここに表示しています。本番では、表示されません。' }),
    el('div', { class: 'actions' }, closeBtn('閉じる')));
}
async function issue(url, title) {
  const r = await api('POST', url);
  if (!r.ok) { alertLine(r.message); return; }
  await show('members');
  issuedDialog(title, r);
}
async function membersPanel() {
  const res = await api('GET', '/api/members');
  const waiting = res.members.filter((m) => !m.approved && !m.withdrawn).length;
  const rows = res.members.map((m) => el('tr', {},
    el('td', { class: 'n', text: String(m.id) }),
    el('td', { class: 'dyn' }, m.kind === 'b2b' ? `${m.company}　${m.contactName}` : m.name),
    el('td', { text: m.kind === 'b2b' ? '法人' : '個人' }),
    el('td', { text: m.loginId ?? '' }),
    el('td', { class: 'n', text: telFmt(m.phone) }),
    el('td', { class: 'dyn', text: m.email + (m.emailVerified ? '' : '（未確認）') }),
    el('td', { class: 'dyn' }, m.rejected ? '承認しなかった' : m.withdrawn ? '退会' : !m.approved ? el('span', { class: 'warn', text: '承認待ち' }) : m.suspendedBy === 'manual' ? el('span', { class: 'warn', text: `停止中: ${m.suspendReason}` })
      : m.suspendedBy === 'unpaid' ? el('span', { class: 'warn', text: '未払いによる停止（消し込むと、自動で解ける）' }) : '利用中'),
    act(
      !m.approved && !m.withdrawn && smallBtn('承認する', () => issue(`/api/members/${m.id}/approve`, `会員 ${m.id} を承認しました`), 'btn-primary'),
      !m.approved && !m.withdrawn && smallBtn('承認しない', () => askReason(`会員 ${m.id} の登録を承認しない`, '理由（記録に残ります。本人には送りません）', true, (reason) => api('POST', `/api/members/${m.id}/reject`, { reason })), 'btn-danger'),
      m.approved && !m.withdrawn && smallBtn(m.loginId ? 'パスワードを再発行' : 'ログイン情報を発行', () => issue(`/api/members/${m.id}/credentials`, `会員 ${m.id} のログイン情報を発行しました`)),
      !m.withdrawn && smallBtn('電話番号を変更', () => askForm(`会員 ${m.id} の電話番号を変更`, '本人を確かめたうえで、変更してください。変更すると、古い番号でのログインは切れます。',
        [field('新しい電話番号', 'phone', { type: 'tel', inputMode: 'tel', required: true }), field('本人を確かめた方法', 'reason', { required: true, placeholder: '会場で、運転免許証で確かめた' })], (d) => api('POST', `/api/members/${m.id}/phone`, d), '変更する')),
      m.suspendedBy === 'manual'
      ? smallBtn('停止を解く', async () => { await api('POST', `/api/members/${m.id}/unsuspend`); show('members'); })
      : !m.withdrawn && m.suspendedBy !== 'unpaid' && smallBtn('停止', () => askReason(`会員 ${m.id} を停止`, '停止の理由', true, (reason) => api('POST', `/api/members/${m.id}/suspend`, { reason })), 'btn-danger'))));
  return [el('p', { class: 'msg', id: 'line', role: 'alert' }),
    waiting ? el('div', { class: 'banner', role: 'status' }, el('span', { text: `承認待ちの会員登録が ${waiting} 件あります。承認すると、ログイン ID とパスワードが、本人へメールで送られます。` })) : null,
    table(['会員番号', '名前', '区分', 'ログイン ID', '電話番号', 'メール', '状態', ''], rows, '会員はまだいません。')];
}

// ------------------------------------------------------------ 受付: 来場確認（FR-MODE-002・004）と、会場の QR コード
const PAY = { transfer: '銀行振込', cash: '当日現金' };
const RECV = { pickup: '現地受け取り', ship: '配送' };
async function receptionPanel() {
  const res = await api('GET', '/api/reception');
  if (!res.ok) return [el('p', { class: 'msg', text: res.message })];
  if (!res.event) return [el('p', { class: 'empty', text: '本日の開催はありません。' })];
  const waiting = res.participants.filter((p) => p.mode === 'venue' && !p.checkedIn).length;
  const rows = res.participants.map((p) => el('tr', {},
    el('td', { class: 'n paddle', text: String(p.paddle) }),
    el('td', { class: 'dyn', text: p.name }),
    el('td', { text: p.mode === 'venue' ? '会場' : 'オンライン' }),
    el('td', { text: `${RECV[p.receive]}・${PAY[p.payment]}` }),
    el('td', {}, p.mode === 'venue' ? el('span', { class: 'state', 'data-on': p.checkedIn ? '1' : '0', text: p.checkedIn ? '来場確認済み' : '確認待ち' }) : ''),
    act(
      p.mode === 'venue' && !p.checkedIn && smallBtn('来場を確認', async () => { const r = await api('POST', `/api/reception/${p.id}/checkin`); if (!r.ok) alertLine(r.message); show('reception'); }, 'btn-primary'),
      p.mode === 'online' && smallBtn('会場参加に切り替え', () => switchDialog(p)))));
  return [
    el('div', { class: 'toolbar' },
      el('p', { class: 'dyn', text: `${res.event.title}　確認待ち ${waiting} 人` }),
      el('div', {}, smallBtn('更新', () => show('reception')), ' ',
        smallBtn('参加手続きを代わりに行う', () => askForm('参加手続きを、代わりに行う', '会員登録は済んでいるが、端末で手続きできない人に使います。受け取り方法と支払方法を、本人に聞いて選んでください。会場参加・来場確認済みになります。',
          [field('会員の電話番号', 'phone', { type: 'tel', inputMode: 'tel', required: true }),
            field('受け取り方法', 'receive', { options: [['', '選んでください'], ['pickup', '現地受け取り'], ['ship', '配送']] }),
            field('支払方法', 'payment', { options: [['', '選んでください'], ['cash', '当日現金'], ['transfer', '銀行振込']] })],
          async (d) => { const r = await api('POST', '/api/reception/join', d); if (r.ok) alertLine(`参加番号 ${r.paddle} を振りました。この番号の札を渡してください。`); return r; }, '参加番号を振る')), ' ',
        smallBtn('会場の QR コード', () => qrDialog(res.event), 'btn-primary'))),
    el('p', { class: 'note', text: '本人と参加番号を確かめてから「来場を確認」を押し、その番号の札を渡してください。' }),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    table(['参加番号', '名前', '参加', '受け取り・支払', '来場', ''], rows, '参加手続きを済ませた人は、まだいません。'),
  ];
}
function switchDialog(p) {
  const form = el('form', { class: 'form', novalidate: true },
    el('p', { text: `参加番号 ${p.paddle} を、オンライン参加から会場参加に切り替えます。支払方法を、本人に聞いて選んでください。` }),
    el('fieldset', { class: 'choice' }, el('legend', { text: '支払方法' }),
      el('label', {}, el('input', { type: 'radio', name: 'payment', value: 'cash' }), '当日現金'),
      el('label', {}, el('input', { type: 'radio', name: 'payment', value: 'transfer' }), '銀行振込')),
    msgLine(),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '切り替えて、来場を確認' }), closeBtn('やめる')));
  onSubmit(form, async (data) => {
    const res = await api('POST', `/api/reception/${p.id}/checkin`, { payment: data.payment });
    if (res.ok) { dlg.close(); show('reception'); }
    return res;
  });
  openDialog('会場参加に切り替え', form);
}
function qrDialog(event) {
  openDialog('会場の QR コード',
    el('p', { class: 'dyn', text: `${event.title}　会場参加の方は、このコードを読み取ってください。` }),
    el('img', { class: 'qr', src: '/api/reception/qr.svg', alt: '会場参加の QR コード', width: 320, height: 320 }),
    el('p', { class: 'note', text: 'このコードは、開催ごとに変わります。会場の中にだけ掲示してください。' }),
    el('div', { class: 'actions' }, smallBtn('印刷', () => window.print()), closeBtn()));
}

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
  el('p', { class: 'note', text: '認証アプリ（Google Authenticator など）で、QR コードを読み取ります。読み取れないときは「セットアップキーを入力」で鍵を入れます（種類は「時間ベース」）。' }),
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
  const res = await api('GET', '/api/billing/lines');
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
        a && ['billed', 'unpaid'].includes(l.state) && smallBtn('消し込み', () => askForm('振込の消し込み', `${l.name}　${l.label}。入金の金額が、明細の金額（${yen(l.payable)}${l.premium ? '。買歩銭を含む' : ''}）と一致するときだけ消し込めます。`,
          [field('入金の金額（円）', 'amount', { inputMode: 'numeric', required: true }), field('メモ', 'memo', {}, '任意')], (d) => api('POST', `/api/billing/lines/${l.id}/clear`, { amount: Number(d.amount), memo: d.memo }), '消し込む'), 'btn-primary'),
        a && l.state === 'unpaid' && smallBtn('督促', () => askForm('督促の記録', l.dunning.map((d) => `${dateFmt.format(d.at)} ${d.method}: ${d.body}`).join('\n'),
          [field('方法', 'method', { required: true, placeholder: '電話・メールなど' }), field('内容', 'body', { rows: 3, required: true })], (d) => api('POST', `/api/billing/lines/${l.id}/dun`, d), '記録する')),
        a && l.state === 'unpaid' && smallBtn('解除…', () => askReason('落札を解除', '解除の理由（取り消せません。本人にメールで知らせます）', true, (reason) => api('POST', `/api/billing/lines/${l.id}/cancel`, { reason })), 'btn-danger'),
        l.state === 'cleared' && l.kind !== 'penalty' && l.kind !== 'late' && smallBtn('引き渡し', () => post(`/api/billing/lines/${l.id}/deliver`), 'btn-primary'),
        a && l.state === 'cleared' && smallBtn('消し込みを取り消す', () => askReason('消し込みを取り消す', '取り消しの理由', true, (reason) => api('POST', `/api/billing/lines/${l.id}/unclear`, { reason }))),
        a && l.state === 'delivered' && smallBtn('引き渡しを取り消す', () => askReason('引き渡しの記録を取り消す', '取り消しの理由', true, (reason) => api('POST', `/api/billing/lines/${l.id}/undeliver`, { reason }))),
        a && l.state === 'cancelled' && l.kind === 'lot' && !l.offer && smallBtn('繰り上げを打診', () => post(`/api/billing/lines/${l.id}/offer`)),
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
    el('div', { class: 'toolbar' }, el('p', { class: 'note', text: '当日現金は、明細を選んで「精算」。振込は、入金を確かめて「消し込み」。引き渡しは、消し込みのあとにだけ記録できます。' }),
      el('div', { class: 'exports' }, settleBtn, isAdmin() && el('span', { class: 'exports__label', text: '書き出す:' }),
        isAdmin() && el('a', { class: 'btn btn-quiet', href: '/api/billing/shipping.csv', text: '配送の一覧（CSV）' }),
        isAdmin() && el('a', { class: 'btn btn-quiet', href: `/api/billing/ledger.csv?month=${res.today.slice(0, 7)}`, text: '帳簿用の記録（CSV）' }),
        isAdmin() && el('a', { class: 'btn btn-quiet', href: `/api/billing/invoices.xlsx?month=${res.today.slice(0, 7)}`, text: '請求書の一覧（Excel）' }))),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    table(['', '参加番号', '落札者・品', '金額', '受け取り・支払', '状態', ''], rows, '落札した品は、まだありません。'),
  ];
  if (isAdmin()) {
    const inv = await api('GET', '/api/billing/invoices');
    nodes.push(el('h2', { class: 'subhead', text: '請求書' }),
      el('p', { class: 'note', text: '支払期限は、発行日の5日後です（違約金などは7日後）。メールの下書きを送ったら「送付済みにする」を押してください。' }),
      table(['請求番号', '宛先', '種類', '金額', '発行日', '送付・期限', ''], inv.invoices.map((i) => el('tr', {},
        el('td', { class: 'n', text: i.number }), el('td', { class: 'dyn', text: i.name }), el('td', { text: INV_KIND[i.kind] }), el('td', { class: 'n', text: yen(i.total) }), el('td', { class: 'n', text: jpDay(i.issuedOn) }),
        el('td', {}, i.kind === 'cash' ? 'その場で渡した' : el('span', { class: !i.sentOn && i.stale ? 'warn' : '', text: `${i.sentOn ? `送付 ${jpDay(i.sentOn)}` : i.draft === 'failed' ? '未送付（下書きの作成に失敗）' : '未送付'}　期限 ${jpDay(i.dueDate)}` })),
        act(el('a', { class: 'btn', href: `/api/billing/invoices/${i.id}/pdf`, text: 'PDF' }), el('a', { class: 'btn', href: `/api/billing/invoices/${i.id}/xlsx`, text: 'Excel' }),
          !['cash', 'penalty'].includes(i.kind) && !i.sentOn && smallBtn(i.shipping ? `送料 ${yen(i.shipping.amount)}` : '送料を入力', () => shippingForm(i.accountId, i.eventId, i.name, i.shipping)),
          i.kind !== 'cash' && (i.sentOn ? smallBtn('送付を取り消す', () => post(`/api/billing/invoices/${i.id}/unsent`)) : smallBtn('送付済みにする', () => post(`/api/billing/invoices/${i.id}/sent`), 'btn-primary'))))), '請求書は、まだありません。'));
  }
  return nodes;
}
async function pickupPanel() {
  const res = await api('GET', '/api/billing/pickup');
  return [el('p', { class: 'note', text: '現地受け取りで、支払いは済んでいるのに、まだ受け取っていない品です。期限は、消し込みの日の翌日から7日目まで。' }),
    table(['落札者', '品', '消し込み', '受け取り期限'], res.lines.map((l) => el('tr', {},
      el('td', { class: 'dyn', text: l.name }), el('td', { class: 'dyn', text: l.label }), el('td', { class: 'n', text: l.clearedOn }),
      el('td', {}, el('span', { class: l.pickupLate ? 'warn' : 'n', text: `${jpDay(l.pickupBy)}${l.pickupLate ? '（期限を過ぎています）' : ''}` })))), '未引き取りの品はありません。')];
}
let feeMonth = null;
async function feesPanel() {
  const [f, long] = await Promise.all([api('GET', '/api/billing/fees' + (feeMonth ? `?month=${feeMonth}` : '')), api('GET', '/api/billing/long-unpaid')]);
  feeMonth = f.month;
  const pick = el('input', { class: 'input', type: 'month', value: f.month, 'aria-label': '月', onchange: (ev) => { feeMonth = ev.target.value; show('fees'); } });
  return [
    el('div', { class: 'toolbar' }, el('div', { class: 'monthpick' }, pick),
      f.confirmedOn ? el('p', { text: `確認済み（${f.confirmedOn}）` }) : isAdmin() && smallBtn('この月の明細を、確認済みにする', () => post('/api/billing/fees/confirm', { month: f.month }), 'btn-primary')),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    el('dl', { class: 'facts' },
      el('dt', { text: '対象の落札額（消し込み済み・税込）' }), el('dd', { class: 'n', text: yen(f.base) }),
      el('dt', { text: `手数料（${f.rate}%。差し引き ${yen(f.deduction)}）` }), el('dd', { class: 'n', text: yen(f.fee) }),
      el('dt', { text: '最低保証額' }), el('dd', { class: 'n', text: yen(f.minimum) }),
      el('dt', { text: `消費税（${f.taxMode === 'exclusive' ? '外税' : '内税'}）` }), el('dd', { class: 'n', text: f.taxMode === 'exclusive' ? yen(f.tax) : '手数料に含む' }),
      el('dt', { text: '請求額' }), el('dd', { class: 'n paddle', text: yen(f.total) })),
    el('h2', { class: 'subhead', text: '根拠になる明細' }),
    table(['品', '税込落札額', '支払方法', '消し込みの日', '返金・取り消し'], f.details.map((d) => el('tr', {},
      el('td', { class: 'dyn', text: d.label }), el('td', { class: 'n', text: yen(Math.abs(d.amount)).replace('¥', d.amount < 0 ? '−¥' : '¥') }), el('td', { text: d.method ?? '' }), el('td', { class: 'n', text: d.clearedOn }), el('td', { text: d.note }))), 'この月の明細はありません。'),
    el('h2', { class: 'subhead', text: '長く未払いのままの明細（期限の翌日から30日以上）' }),
    table(['落札者', '品', '金額', '期限', '督促', '引き渡し'], long.lines.map((l) => el('tr', {},
      el('td', { class: 'dyn', text: l.name }), el('td', { class: 'dyn', text: l.label }), el('td', { class: 'n', text: yen(l.amount) }), el('td', { class: 'n', text: jpDay(l.invoice.dueDate) }),
      el('td', { text: `${l.dunning.length} 回` }), el('td', { text: l.deliveredOn ? '済' : '未' }))), '該当する明細はありません。'),
  ];
}

// ------------------------------------------------------------ SMS の制限の解除（受付係もできる）
function smsPanel() {
  const form = el('form', { class: 'form', novalidate: true },
    field('電話番号', 'phone', { type: 'tel', inputMode: 'tel', required: true }, '会場で本人を確かめたうえで、認証番号の送信の制限（1時間に5回）を解きます'),
    el('p', { class: 'msg', role: 'alert', tabIndex: -1 }),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '制限を解く' })));
  onSubmit(form, async (data) => {
    const res = await api('POST', '/api/sms-limit/reset', data);
    if (res.ok) { const m = $('.msg', form); m.classList.add('ok'); m.textContent = '制限を解きました'; form.reset(); return null; }
    return res;
  });
  return [el('div', { class: 'narrowcol' }, form)];
}

// ------------------------------------------------------------ スタッフ
// メールアドレスを登録した（または、パスワードを決め直せるようにした）あとの知らせ
function inviteDialog(title, res) {
  openDialog(title,
    el('p', { class: 'dyn', text: `${res.email} を登録しました。本人に、スタッフのログインの画面の「はじめての方」から、このメールアドレスを入れて、パスワードを決めるよう、お伝えください。` }),
    el('p', { class: 'note', text: 'パスワードを決められるのは、7日以内です。メールアドレスを知っている人なら、だれでも決められるので、早めに決めてもらってください。' }),
    el('div', { class: 'actions' }, closeBtn('閉じる')));
}
async function staffPanel() {
  const res = await api('GET', '/api/staff/accounts');
  const rows = res.staff.map((s) => el('tr', {},
    el('td', { class: 'dyn', text: s.email ?? `${s.loginId}（ログイン ID）` }), el('td', { class: 'dyn', text: s.name }), el('td', { text: s.roleLabel }),
    el('td', { text: !s.active ? '停止' : s.ready ? '利用中' : 'パスワードの登録待ち' }),
    act(s.active && smallBtn(s.email ? 'パスワードを決め直せるようにする' : '再発行', async () => { const r = await api('POST', `/api/staff/accounts/${s.id}/reset`); if (!r.ok) return alertLine(r.message); await show('staff'); if (r.email) inviteDialog('パスワードを消しました', r); else secretsDialog('パスワードと認証アプリを再発行しました', r); }),
      s.active && s.loginId !== me.loginId && smallBtn('停止', async () => { const r = await api('POST', `/api/staff/accounts/${s.id}/stop`); if (!r.ok) alertLine(r.message); else show('staff'); }, 'btn-danger'))));
  return [
    el('div', { class: 'toolbar' }, smallBtn('パスワードを変える', passwordDialog), smallBtn('スタッフのメールアドレスを登録', staffDialog, 'btn-primary')),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    table(['メールアドレス', '名前', '役割', '状態', ''], rows, ''),
  ];
}
function staffDialog() {
  const form = el('form', { class: 'form', novalidate: true },
    field('メールアドレス', 'email', { type: 'email', inputMode: 'email', required: true, autocapitalize: 'none', spellcheck: false }, 'このメールアドレスで、ログインします。パスワードは、本人が最初のログインで決めます'),
    field('名前', 'name', { required: true }),
    field('役割', 'role', { options: [['auctioneer', '進行役'], ['reception', '受付係'], ['admin', '主催者管理者'], ['operator', '開発・運営者（手数料と記録を見るだけ）']] }),
    field('電話番号', 'phone', { type: 'tel', inputMode: 'tel' }, '任意。この番号では会員登録できなくなります'),
    msgLine(),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '作る' }), closeBtn()));
  onSubmit(form, async (data) => {
    const res = await api('POST', '/api/staff/accounts', data);
    if (res.ok) {
      await show('staff');
      inviteDialog('スタッフのメールアドレスを登録しました', res);
    }
    return res;
  });
  openDialog('スタッフのメールアドレスを登録', form);
}
function passwordDialog() {
  const form = el('form', { class: 'form', novalidate: true },
    field('いまのパスワード', 'current', { type: 'password', autocomplete: 'current-password', required: true }),
    field('新しいパスワード', 'next', { type: 'password', autocomplete: 'new-password', required: true, minLength: 12 }, '12文字以上'),
    msgLine(),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '変える' }), closeBtn()));
  onSubmit(form, async (data) => {
    const res = await api('POST', '/api/staff/password', data);
    if (res.ok) dlg.close();
    return res;
  });
  openDialog('パスワードを変える', form);
}

// ------------------------------------------------------------ 設定
// 印鑑の画像の登録。画像は、サーバーのデータの置き場にだけ保存する
function sealBox() {
  const preview = el('img', { class: 'seal', alt: '登録してある印鑑', width: 96, height: 96, hidden: true });
  const note = el('p', { class: 'note', text: '登録されていません。' });
  const refresh = () => { preview.onload = () => { preview.hidden = false; note.textContent = '登録済みです。'; }; preview.onerror = () => { preview.hidden = true; note.textContent = '登録されていません。'; }; preview.src = `/api/settings/seal?${Date.now()}`; };
  const input = el('input', { type: 'file', accept: 'image/png,image/jpeg', class: 'sr-only', id: 'sealInput' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { note.textContent = '画像は、2MB までにしてください。'; return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const res = await api('POST', '/api/settings/seal', { image: btoa(bin) });
    if (res.ok) refresh(); else note.textContent = res.message;
  });
  refresh();
  return el('div', { class: 'sealbox' }, preview, el('div', {}, note, input, el('label', { class: 'btn', htmlFor: 'sealInput', text: '画像を選ぶ' }), ' ',
    el('button', { class: 'btn', type: 'button', text: '登録を消す', onclick: async () => { await api('POST', '/api/settings/seal', { image: null }); refresh(); } })));
}
// 規約類（利用規約・特定商取引法に基づく表示・プライバシーポリシー）の文面
async function legalBox() {
  const res = await api('GET', '/api/legal');
  const form = el('form', { class: 'form', novalidate: true },
    el('p', { class: 'note' }, '文面を入れると、', el('a', { href: '/legal.html', text: '規約のページ' }), 'に出ます。利用規約を入れると、会員登録のときに同意が必須になります。'),
    field('利用規約', 'terms', { value: res.docs.terms.body, rows: 8 }),
    field('特定商取引法に基づく表示', 'tokushoho', { value: res.docs.tokushoho.body, rows: 8 }),
    field('プライバシーポリシー', 'privacy', { value: res.docs.privacy.body, rows: 8 }),
    el('p', { class: 'msg', role: 'alert', tabIndex: -1 }),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '規約類を保存する' })));
  onSubmit(form, async (data) => {
    const r = await api('POST', '/api/settings/legal', data);
    if (r.ok) { const m = $('.msg', form); m.classList.add('ok'); m.textContent = '保存しました'; return null; }
    return r;
  });
  return el('div', {}, el('h2', { class: 'subhead', text: '規約類' }), form);
}
async function settingsPanel() {
  const s = await api('GET', '/api/settings');
  const form = el('form', { class: 'form', novalidate: true },
    field('主催者の名称', 'orgName', { value: s.orgName, required: true }),
    field('返品特約の表示', 'returnPolicy', { value: s.returnPolicy, rows: 4, required: true }, 'トップページに表示します。弁護士の確認が済むまでは仮の文言です'),
    field('送料の表示', 'shippingNotice', { value: s.shippingNotice, rows: 3, required: true }, 'トップページに表示します'),
    el('h2', { class: 'subhead', text: '請求書に載せる内容' }),
    field('住所', 'orgAddress', { value: s.orgAddress, rows: 2 }, '郵便番号から。改行できます'),
    el('div', { class: 'grid2' }, field('電話番号', 'orgTel', { value: s.orgTel }), field('メールアドレス', 'orgEmail', { value: s.orgEmail })),
    field('適格請求書発行事業者の登録番号', 'invoiceRegNo', { value: s.invoiceRegNo }, 'T から始まる番号'),
    field('振込先の口座', 'bankAccount', { value: s.bankAccount }),
    el('h2', { class: 'subhead', text: '印鑑（請求書に押す）' }),
    sealBox(),
    el('h2', { class: 'subhead', text: '買歩銭' }),
    field('買歩銭の割合（%）', 'buyerPremiumRate', { value: s.buyerPremiumRate, inputMode: 'numeric' }, '落札者が、落札額に上乗せして払う手数料。変えても、すでに落札した品の金額は変わりません'),
    el('h2', { class: 'subhead', text: '違約金・遅延損害金' }),
    el('div', { class: 'grid2' },
      field('解除の違約金（法人。落札額の %）', 'penaltyRateB2b', { value: s.penaltyRateB2b, inputMode: 'decimal' }),
      field('解除の違約金（個人。落札額の %）', 'penaltyRateB2c', { value: s.penaltyRateB2c, inputMode: 'decimal' }),
      field('遅延損害金（法人。年率 %）', 'lateRateB2b', { value: s.lateRateB2b, inputMode: 'decimal' }),
      field('遅延損害金（個人。年率 %）', 'lateRateB2c', { value: s.lateRateB2c, inputMode: 'decimal' })),
    el('p', { class: 'note', text: '率を入れると、違約金・遅延損害金を請求するときに、金額の案が出ます（確定は、金額を確かめてから）。空なら、金額を手で入れます。' }),
    el('h2', { class: 'subhead', text: '手数料の集計' }),
    el('div', { class: 'grid2' },
      field('消費税の扱い', 'feeTaxMode', { options: [['exclusive', '外税（手数料に消費税を足す）'], ['inclusive', '内税（手数料に含む）']], value: s.feeTaxMode || 'exclusive' }),
      field('最低保証額（円）', 'feeMinimum', { value: s.feeMinimum, inputMode: 'numeric' }, '未定なら空のまま')),
    el('p', { class: 'msg', role: 'alert', tabIndex: -1 }),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '保存する' })));
  onSubmit(form, async (data) => {
    const res = await api('POST', '/api/settings', data);
    if (res.ok) { const m = $('.msg', form); m.classList.add('ok'); m.textContent = '保存しました'; return null; }
    return res;
  });
  return [el('div', { class: 'narrowcol' }, form, await legalBox())];
}

// ------------------------------------------------------------ 記録（監査ログ・知らせ）
// 記録の「操作」を、読める言葉にする（無いものは、そのまま出す）
const AUDIT_TEXT = {
  'staff.login': 'スタッフがログイン', 'staff.create': 'スタッフを登録', 'staff.reset': 'スタッフのパスワードを再発行', 'staff.stop': 'スタッフを停止', 'staff.password_change': 'スタッフがパスワードを変更',
  'member.register': '会員登録', 'member.approve': '会員登録を承認', 'member.reject': '会員登録を承認しない', 'member.credentials_issue': 'ログイン情報を発行', 'member.credentials': '会員がパスワードを変更', 'member.update': '会員が登録内容を変更', 'member.withdraw': '会員が退会', 'member.suspend': '会員を停止', 'member.unsuspend': '会員の停止を解除', 'member.phone_change': '会員の電話番号を変更',
  'event.create': '開催を登録', 'event.update': '開催を変更', 'event.publish': '開催を公開', 'event.join': '参加手続き', 'participation.change': '参加の内容を変更',
  'lot.create': '品を登録', 'proxy.bid': '代理で入札', 'proxy.cancel': '代理の入札を取り消し',
  'reception.checkin': '来場を確認', 'reception.join': '参加手続きを代行',
  'billing.settle': '当日現金で精算', 'billing.clear': '入金を消し込み', 'billing.unclear': '消し込みを取り消し', 'billing.deliver': '引き渡し', 'billing.undeliver': '引き渡しを取り消し',
  'billing.cancel': '落札を解除', 'billing.penalty': '違約金を請求', 'billing.refund': '返金', 'billing.offer': '繰り上げを案内', 'billing.dun': '督促', 'billing.memo': 'メモを変更', 'billing.receive': '受け取り方法を変更',
  'billing.shipping': '送料を入力', 'billing.shipping_export': '配送の一覧を書き出し', 'billing.ledger_export': '帳簿用の記録を書き出し',
  'invoice.issue_on_end': '請求書を発行', 'invoice.sent': '請求書を送付済みに', 'invoice.unsent': '送付済みを取り消し', 'offer.accept': '繰り上げを承諾', 'offer.decline': '繰り上げを辞退',
  'fee.confirm': '手数料の明細を確認', 'settings.update': '設定を変更', 'event.mail': '開催のお知らせメールを送信', 'member.event_mail': '開催のお知らせメールの受け取りを変更', 'settings.legal': '規約を変更', 'settings.seal': '印鑑の画像を変更', 'sms.limit_reset': 'SMS の制限を解除',
};
// 記録の「前」「後」（機械向けの形）を、読める言葉にする
const AUDIT_KEY = { mode: '参加', payment: '支払', receive: '受け取り', checkedIn: '来場確認', paddle: '参加番号', kind: '区分', fields: '変えた項目', loginId: 'ログイン ID', role: '役割', by: '登録元', amount: '金額', title: '名前', status: '状態', reason: '理由', memo: 'メモ', shipping: '送料', dueDate: '期限', number: '請求番号' };
const AUDIT_VALUE = { venue: '会場', online: 'オンライン', cash: '当日現金', transfer: '銀行振込', pickup: '現地受け取り', ship: '配送', b2c: '個人', b2b: '法人', true: 'はい', false: 'いいえ', admin: '主催者管理者', auctioneer: '進行役', reception: '受付係', operator: '開発運営者' };
function auditText(raw) {
  if (!raw) return '';
  let v;
  try { v = JSON.parse(raw); } catch { return raw; }
  if (v === null || typeof v !== 'object') return String(v);
  const show = (x) => (Array.isArray(x) ? x.map(show).join('・') : x !== null && typeof x === 'object' ? JSON.stringify(x) : AUDIT_VALUE[String(x)] ?? String(x));
  return Object.entries(v).map(([k, x]) => `${AUDIT_KEY[k] ?? k}: ${show(x)}`).join('、');
}
async function auditPanel() {
  const [audit, notices] = await Promise.all([api('GET', '/api/audit'), api('GET', '/api/notices')]);
  const who = (e) => (e.actor_kind === 'staff' ? `スタッフ ${e.actor_id}` : e.actor_kind === 'member' ? `会員 ${e.actor_id}` : e.actor_kind === 'system' ? 'システム' : '');
  return [
    (notices.notices ?? []).length ? el('div', { class: 'banner', role: 'alert' }, el('span', { text: `送信に失敗した知らせが ${notices.notices.length} 件あります（SMS・メール）。` })) : null,
    table(['日時', '操作', '誰が', '対象', '前', '後', '理由'], audit.entries.map((e) => el('tr', {},
      el('td', { class: 'n', text: dateFmt.format(e.at) }), el('td', { text: AUDIT_TEXT[e.type] ?? e.type }), el('td', { text: who(e) }), el('td', { text: e.target }),
      el('td', { class: 'dyn', text: auditText(e.before) }), el('td', { class: 'dyn', text: auditText(e.after) }), el('td', { class: 'dyn', text: e.reason ?? '' }))), '記録はまだありません。'),
  ];
}

// ------------------------------------------------------------ 切り替え
const PANELS = {
  reception: ['受付', receptionPanel, ['admin', 'auctioneer', 'reception']],
  billing: ['請求', billingPanel, ['admin', 'reception']],
  pickup: ['未引き取り', pickupPanel, ['admin', 'auctioneer', 'reception']],
  fees: ['手数料', feesPanel, ['admin', 'operator']],
  events: ['開催', eventsPanel, ['admin']],
  members: ['会員', membersPanel, ['admin']],
  sms: ['SMS の制限', smsPanel, ['admin', 'auctioneer', 'reception']],
  staff: ['スタッフ', staffPanel, ['admin']],
  settings: ['設定', settingsPanel, ['admin']],
  audit: ['記録', auditPanel, ['admin', 'operator']],
};
async function show(key) {
  current = key;
  // 開いているタブを URL に載せる（読み込み直しても、同じタブに戻る。URL を人に渡せる）
  if (location.hash.slice(1) !== key) history.replaceState(null, '', `#${key}`);
  for (const b of $('#tabs').children) b.setAttribute('aria-selected', String(b.dataset.key === key));
  const nodes = await PANELS[key][1]();
  if (current === key) panel.replaceChildren(...nodes.filter(Boolean));
}

// ログインのあとの行き先（進行コンソール・会場モニターから来た人は、そこへ戻す）
const afterLogin = (role) => { location.href = toMonitor ? '/monitor.html' : toConsole && ['admin', 'auctioneer'].includes(role) ? '/console.html' : '/staff.html'; };
onSubmit($('#loginForm'), async (data) => {
  const res = await api('POST', '/api/staff/login', { email: data.email, password: data.password });
  if (res.ok) afterLogin(res.staff.role);
  else $('#loginForm').elements.password.value = '';
  return res;
});
// はじめての方: 登録されたメールアドレスを入れて、パスワードを自分で決める
onSubmit($('#setupForm'), async (data) => {
  if (data.password !== data.password2) return { ok: false, message: '入力を確かめてください', errors: { password2: '新しいパスワードが、2つの欄で違っています' } };
  const res = await api('POST', '/api/staff/setup', { email: data.email, password: data.password });
  if (res.ok) afterLogin(res.staff.role);
  return res;
});
$('#firstTime').addEventListener('click', () => { $('#loginForm').hidden = true; $('#setupForm').hidden = false; $('#setupForm').elements.email.value = $('#loginForm').elements.email.value; $('#setupForm').elements.email.focus(); });
$('#backToLogin').addEventListener('click', () => { $('#setupForm').hidden = true; $('#loginForm').hidden = false; $('#loginForm').elements.email.focus(); });
(async () => {
  const state = await setupNav();
  me = state.staff;
  if (!me) { $('#login').hidden = false; $('#loginForm').elements.email.focus(); return; }
  $('#app').hidden = false;
  $('#who').textContent = `${me.name}（${me.roleLabel}）`;
  // 競りの進行は、主催者管理者と進行役（8.14）
  $('#toConsole').hidden = !['admin', 'auctioneer'].includes(me.role);
  $('#toMonitor').hidden = me.role === 'operator'; // 会場の大型モニターは、会場にいるスタッフが開く
  // SMS を使わない設定（本番）のときは、「SMS の制限」を出さない
  const terms = await api('GET', '/api/terms');
  const keys = Object.keys(PANELS).filter((k) => PANELS[k][2].includes(me.role) && !(k === 'sms' && terms.sms === false));
  $('#tabs').replaceChildren(...keys.map((k) => el('button', { type: 'button', role: 'tab', 'data-key': k, text: PANELS[k][0], onclick: () => show(k) })));
  show(keys.includes(location.hash.slice(1)) ? location.hash.slice(1) : keys[0]);
})();
