// 管理画面: スタッフ・設定・記録（報告書 122 章で、staff.js から分けた。読み込む順番は staff.html のとおり。名前は、ファイルをまたいで共有する）
'use strict';

// ------------------------------------------------------------ スタッフ
// メールアドレスを登録した（または、パスワードを決め直せるようにした）あとの知らせ
function inviteDialog(title, res) {
  openDialog(title,
    el('p', { class: 'dyn', text: `${res.email} に、パスワードを決めるためのメールを送りました。本人が、メールの中のリンクを開いて、パスワードを決めます（7日以内。リンクは、1回だけ使えます）。` }),
    // お試し用の設定のあいだは、メールが実際には届かないので、リンクをここに出す
    res.devSetupUrl && el('p', { class: 'note', text: '【お試し用】メールは、実際には届きません。次のリンクを、本人に渡してください。' }),
    res.devSetupUrl && el('p', { class: 'copyrow' }, noTranslate(el('span', { class: 'secret dyn', id: 'devSetupUrl', text: res.devSetupUrl }))),
    el('div', { class: 'actions' }, closeBtn('閉じる')));
}
async function staffPanel() {
  const res = await api('GET', '/api/staff/accounts');
  const rows = res.staff.map((s) => el('tr', {},
    el('td', { class: 'dyn', text: s.email ?? `${s.loginId}（ログイン ID）` }), el('td', { class: 'dyn', text: s.name }), el('td', { text: s.roleLabel }),
    el('td', { text: !s.active ? '停止' : s.ready ? '利用中' : 'パスワードの登録待ち' }),
    act(s.active && smallBtn(s.email ? 'パスワードの再設定' : '再発行', () => confirmDo(
        s.email ? `${s.name}さんのパスワードを消しますか？` : `${s.name}さんのパスワードと認証アプリを再発行しますか？`,
        s.email ? `いまのパスワードは使えなくなり、ログイン中の画面もすべて切れます。${s.email} に、パスワードを決め直す案内を送ります。` : 'いまのパスワードと認証アプリは使えなくなり、ログイン中の画面もすべて切れます。',
        s.email ? 'パスワードを消す' : '再発行する',
        () => api('POST', `/api/staff/accounts/${s.id}/reset`),
        { danger: true, then: async (r) => { await show('staff'); if (r.email) inviteDialog('パスワードを消しました', r); else secretsDialog('パスワードと認証アプリを再発行しました', r); } })),
      s.active && s.loginId !== me.loginId && smallBtn('停止', () => confirmDo(`${s.name}さんを停止しますか？`,
        'ログインできなくなり、ログイン中の画面もすべて切れます。あとから「停止を解く」で戻せます。', '停止する',
        () => api('POST', `/api/staff/accounts/${s.id}/stop`), { danger: true }), 'btn-danger'),
      !s.active && smallBtn('停止を解く', () => confirmDo(`${s.name}さんの停止を解きますか？`,
        '停止の前と同じパスワードで、またログインできるようになります。', '停止を解く',
        () => api('POST', `/api/staff/accounts/${s.id}/reactivate`)), 'btn-primary'))));
  return [
    el('div', { class: 'toolbar' }, el('span'), smallBtn('スタッフを登録', staffDialog, 'btn-primary')),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    table(['メールアドレス', '名前', '役割', '状態', ''], rows, ''),
  ];
}
function staffDialog() {
  const form = el('form', { class: 'form', novalidate: true },
    field('メールアドレス', 'email', { type: 'email', inputMode: 'email', required: true, autocapitalize: 'none', spellcheck: false }, 'このメールアドレスで、ログインします。パスワードは、本人が最初のログインで決めます'),
    field('名前', 'name', { required: true }),
    field('役割', 'role', { options: [['auctioneer', '進行役'], ['caller', 'オークショニア（競りの最中の開始価格・うりきり・締め・流札だけ）'], ['reception', '受付係'], ['admin', '主催者管理者'], ['operator', '開発・運営者（手数料と記録を見るだけ）']] }),
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
function sealBox(fixed = false) {
  const preview = el('img', { class: 'seal', alt: '登録してある印鑑', width: 96, height: 96, hidden: true });
  const note = el('p', { class: 'note', text: '登録されていません。' });
  // 「登録を消す」は、登録してあるときだけ出す（報告書 83 章）
  const refresh = () => { preview.onload = () => { preview.hidden = false; note.textContent = '登録済みです。'; const d = $('#sealDelete'); if (d) d.hidden = false; }; preview.onerror = () => { preview.hidden = true; note.textContent = '登録されていません。'; const d = $('#sealDelete'); if (d) d.hidden = true; }; preview.src = `/api/settings/seal?${Date.now()}`; };
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
  // 原本の印鑑で固定しているときは、ここでは変えられない（配るときの設定で変える）
  if (fixed) { preview.onload = () => { preview.hidden = false; note.textContent = '原本の印鑑を押します（配るときの設定で固定しています）。'; }; return el('div', { class: 'sealbox' }, preview, el('div', {}, note)); }
  return el('div', { class: 'sealbox' }, preview, el('div', {}, note, input, el('label', { class: 'btn', htmlFor: 'sealInput', text: '画像を選ぶ' }), ' ',
    el('button', { class: 'btn', type: 'button', id: 'sealDelete', hidden: true, text: '登録を消す', onclick: () => confirmDo('印鑑の画像を消しますか？', 'これから出す請求書には、印鑑が押されなくなります。', '消す',
      () => api('POST', '/api/settings/seal', { image: null }), { danger: true, then: async () => refresh() }) })));
}
// 規約類（利用規約・特定商取引法に基づく表示・プライバシーポリシー）の文面
async function legalBox() {
  const res = await api('GET', '/api/legal');
  const form = el('form', { class: 'form', novalidate: true },
    field('利用規約', 'terms', { value: res.docs.terms.body, rows: 8 }),
    field('特定商取引法に基づく表示', 'tokushoho', { value: res.docs.tokushoho.body, rows: 8 }),
    field('プライバシーポリシー', 'privacy', { value: res.docs.privacy.body, rows: 8 }),
    el('p', { class: 'msg', role: 'alert', tabIndex: -1 }),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '規約類を保存する' })));
  onSubmit(form, async (data) => {
    const r = await api('POST', '/api/settings/legal', data);
    if (r.ok) { releaseWarning(); unsaved = false; }
    if (r.ok) { const m = $('.msg', form); m.classList.add('ok'); m.textContent = '保存しました'; return null; }
    return r;
  });
  return el('div', {}, el('h2', { class: 'subhead', text: '規約類' }), form);
}
async function settingsPanel() {
  const s = await api('GET', '/api/settings');
  const form = el('form', { class: 'form', novalidate: true },
    field('主催者の名称', 'orgName', { value: s.orgName, required: true }),
    field('古物商の許可', 'kobutsuLicense', { value: s.kobutsuLicense, placeholder: '〇〇県公安委員会　第000000000000号' }, '許可をした公安委員会の名称と、許可証の番号。主催者の名称と一緒に、サイトの下と競りの画面に出します（古物営業法）'),
    field('返品特約の表示', 'returnPolicy', { value: s.returnPolicy, rows: 4, required: true }, 'トップページに表示します。弁護士の確認が済むまでは仮の文言です'),
    field('送料の表示', 'shippingNotice', { value: s.shippingNotice, rows: 3, required: true }, 'トップページに表示します'),
    el('h2', { class: 'subhead', text: '請求書に載せる内容' }),
    field('住所', 'orgAddress', { value: s.orgAddress, rows: 2 }, '郵便番号から。改行できます'),
    el('div', { class: 'grid2' }, field('電話番号', 'orgTel', { value: s.orgTel, type: 'tel', inputMode: 'tel' }), field('メールアドレス', 'orgEmail', { value: s.orgEmail, type: 'email', spellcheck: false })),
    field('適格請求書発行事業者の登録番号', 'invoiceRegNo', { value: s.invoiceRegNo }, 'T から始まる番号'),
    field('振込先の口座', 'bankAccount', { value: s.bankAccount }),
    // 配送: 運送会社の送り状発行システムへ取り込むファイルに入れる番号（契約のときに、運送会社から知らされるもの。報告書 131 章）
    el('details', { class: 'fold' }, el('summary', { text: '配送（運送会社の番号）' }),
      el('p', { class: 'note', text: '「配送」の画面の「運送会社へ」で書き出すファイルに入ります。空のままでも書き出せますが、運送会社のシステムの側で、入力が要ります。ご依頼主には、上の「主催者の名称」「住所」「電話番号」が入ります。' }),
      el('div', { class: 'grid2' },
        field('ヤマト運輸: ご請求先顧客コード', 'yamatoBillingCode', { value: s.yamatoBillingCode, inputMode: 'numeric', autocomplete: 'off' }),
        field('ヤマト運輸: 運賃管理番号', 'yamatoFareNo', { value: s.yamatoFareNo, inputMode: 'numeric', autocomplete: 'off' })),
      field('佐川急便: お客様コード', 'sagawaCustomerCode', { value: s.sagawaCustomerCode, inputMode: 'numeric', autocomplete: 'off' })),
    el('h2', { class: 'subhead', text: '印鑑（請求書に押す）' }),
    sealBox(!!s.sealFixed),
    el('h2', { class: 'subhead', text: '買歩銭' }),
    field('買歩銭の割合（%）', 'buyerPremiumRate', { value: s.buyerPremiumRate, inputMode: 'numeric' }, '落札者が、落札額に上乗せして払う手数料。変えても、すでに落札した品の金額は変わりません'),
    // 契約で一度決めれば変えない項目は、畳んでおく（ふだんの設定の画面を短くする。報告書 83 章）
    el('details', { class: 'fold' }, el('summary', { text: '契約で決める項目（違約金・遅延損害金・手数料）' }),
    el('h2', { class: 'subhead', text: '違約金・遅延損害金' }),
    el('div', { class: 'grid2' },
      field('解除の違約金（法人。落札額の %）', 'penaltyRateB2b', { value: s.penaltyRateB2b, inputMode: 'decimal' }),
      field('解除の違約金（個人。落札額の %）', 'penaltyRateB2c', { value: s.penaltyRateB2c, inputMode: 'decimal' }),
      field('遅延損害金（法人。年率 %）', 'lateRateB2b', { value: s.lateRateB2b, inputMode: 'decimal' }),
      field('遅延損害金（個人。年率 %）', 'lateRateB2c', { value: s.lateRateB2c, inputMode: 'decimal' })),
    el('h2', { class: 'subhead', text: '手数料の集計' }),
    el('div', { class: 'grid2' },
      field('消費税の扱い', 'feeTaxMode', { options: [['exclusive', '外税（手数料に消費税を足す）'], ['inclusive', '内税（手数料に含む）']], value: s.feeTaxMode || 'exclusive' }),
      field('最低保証額（円）', 'feeMinimum', { value: s.feeMinimum, inputMode: 'numeric' }, '未定なら空のまま'))),
    el('p', { class: 'msg', role: 'alert', tabIndex: -1 }),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'submit', text: '保存する' })));
  for (const name of s.fixed ?? []) { const input = form.elements[name]; if (input) { input.readOnly = true; input.setAttribute('aria-readonly', 'true'); } }
  onSubmit(form, async (data) => {
    const res = await api('POST', '/api/settings', data);
    if (res.ok) { releaseWarning(); unsaved = false; }
    if (res.ok) { const m = $('.msg', form); m.classList.add('ok'); m.textContent = '保存しました'; return null; }
    return res;
  });
  return [el('div', { class: 'narrowcol' }, el('div', { class: 'missing', id: 'missingList', hidden: true }), form, await legalBox())];
}

// ------------------------------------------------------------ 記録（監査ログ・知らせ）
// 記録の「操作」を、読める言葉にする（無いものは、そのまま出す）
const AUDIT_TEXT = {
  'member.login': '会員がログイン', 'view.members': '会員の一覧を表示', 'view.invoice': '請求書のファイルを表示', 'billing.invoices_export': '請求書の一覧を書き出し',
  'stream.start': '配信を開始', 'stream.stop': '配信を停止', 'stream.camera': 'カメラを切り替え', 'comment.hide': 'コメントを消した', 'privacy.purge': '保存期間を過ぎた個人情報を削除',
  'staff.login': 'スタッフがログイン', 'staff.create': 'スタッフを登録', 'staff.reset': 'スタッフのパスワードを再発行', 'staff.stop': 'スタッフを停止', 'staff.setup': 'スタッフがパスワードを決めた', 'staff.locked': 'スタッフのログインを一時停止（失敗が続いたため）', 'event.running': '開催を進行中にした', 'event.break': '休憩に入った', 'event.ended': '開催を終了', 'staff.reactivate': 'スタッフの停止を解除', 'staff.password_change': 'スタッフがパスワードを変更',
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
const AUDIT_VALUE = { venue: '会場', online: 'オンライン', cash: '当日現金', card: '当日クレジット', transfer: '銀行振込', pickup: '現地受け取り', ship: '配送', b2c: '個人', b2b: '法人', true: 'はい', false: 'いいえ', admin: '主催者管理者', auctioneer: '進行役', caller: 'オークショニア', reception: '受付係', operator: '開発運営者' };
// 記録の「対象」を、読める形にする（member:12 → 会員 12。報告書 81 章）
const TARGET_KIND = { member: '会員', staff: 'スタッフ', event: '開催', lot: '品', line: '明細', offer: '繰り上げ', participant: '参加者', invoice: '請求書', account: '会員' };
const targetText = (t) => String(t ?? '').replace(/\b([a-z]+):(\d+)\b/g, (m, k, id) => (TARGET_KIND[k] ? `${TARGET_KIND[k]} ${id}` : m));
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
  // 誰が: スタッフは名前で（主催者管理者のときだけ、一覧から引ける）
  const staffNames = me.role === 'admin' ? new Map(((await api('GET', '/api/staff/accounts')).staff ?? []).map((x) => [x.id, x.name])) : new Map();
  const who = (e) => (e.actor_kind === 'staff' ? staffNames.get(e.actor_id) ?? `スタッフ ${e.actor_id}` : e.actor_kind === 'member' ? `会員 ${e.actor_id}` : e.actor_kind === 'system' ? 'システム' : '');
  // 変わる前と後の値は、ふだんは見ないので、「内容」を押したときだけ出す（列を3つ減らす。報告書 83 章）
  const detail = (e) => {
    const before = auditText(e.before), after = auditText(e.after);
    if (!before && !after && !e.reason) return '';
    return el('details', { class: 'auditdetail' }, el('summary', { text: e.reason ? `理由: ${e.reason}` : '内容' }),
      before && el('p', { text: `前: ${before}` }), after && el('p', { text: `後: ${after}` }));
  };
  return [
    (notices.notices ?? []).length ? el('div', { class: 'banner', role: 'alert' }, el('span', { text: `送信に失敗した知らせが ${notices.notices.length} 件あります（SMS・メール）。` })) : null,
    table(['日時', '操作', '誰が', '対象', ''], audit.entries.map((e) => el('tr', {},
      el('td', { class: 'n', text: dateFmt.format(e.at) }), el('td', { text: AUDIT_TEXT[e.type] ?? e.type }), el('td', { class: 'dyn', text: who(e) }), el('td', { text: targetText(e.target) }),
      el('td', { class: 'dyn' }, detail(e)))), '記録はまだありません。'),
  ];
}
