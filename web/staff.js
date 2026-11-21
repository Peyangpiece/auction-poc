// 管理画面: タブの切り替えと、ログイン（報告書 122 章で、staff.js から分けた。読み込む順番は staff.html のとおり。名前は、ファイルをまたいで共有する）
'use strict';

// ------------------------------------------------------------ 切り替え
const PANELS = {
  reception: ['受付', receptionPanel, ['admin', 'auctioneer', 'reception']],
  billing: ['請求', billingPanel, ['admin', 'reception']],
  shipping: ['配送', shippingPanel, ['admin', 'reception']],
  pickup: ['未引き取り', pickupPanel, ['admin', 'auctioneer', 'reception']],
  events: ['開催', eventsPanel, ['admin']],
  members: ['会員', membersPanel, ['admin']],
  staff: ['スタッフ', staffPanel, ['admin']],
  settings: ['設定', settingsPanel, ['admin']],
  fees: ['手数料', feesPanel, ['admin', 'operator']],
  audit: ['記録', auditPanel, ['admin', 'operator']],
};
async function show(key) {
  current = key;
  unsaved = false; // パネルを描き直すと、書きかけの欄はなくなる
  // 開いているタブを URL に載せる（読み込み直しても、同じタブに戻る。URL を人に渡せる）
  if (location.hash.slice(1) !== key) history.replaceState(null, '', `#${key}`);
  for (const b of $('#tabs').children) { b.setAttribute('aria-selected', String(b.dataset.key === key)); b.tabIndex = b.dataset.key === key ? 0 : -1; }
  // 読み込みのあいだは、前のタブの中身を薄くして、読み込み中だと分かるようにする（報告書 82 章）
  panel.setAttribute('aria-busy', 'true');
  const nodes = await PANELS[key][1]();
  if (current !== key) return;
  panel.removeAttribute('aria-busy');
  panel.replaceChildren(...nodes.filter(Boolean));
  if (key === 'settings') renderMissing();
  // ダイアログで実行すると、開いたボタンは描き直しで消える。フォーカスが行き場を失ったら、パネルへ戻す（報告書 81 章）
  if (!document.activeElement || document.activeElement === document.body) panel.focus({ preventScroll: true });
  panel.setAttribute('aria-labelledby', `tab-${key}`);
  if (pendingNotice) { const line = $('#line'); if (line) line.textContent = pendingNotice; pendingNotice = null; }
}

// ログインのあとの行き先（進行コンソール・会場モニターから来た人は、そこへ戻す）
// オークショニアは、オークショニアの画面だけを使う
const afterLogin = (role) => { location.href = role === 'caller' || (toCaller && role === 'admin') ? '/caller.html' : toMonitor ? '/monitor.html' : toConsole && ['admin', 'auctioneer'].includes(role) ? '/console.html' : '/staff.html'; };
onSubmit($('#loginForm'), async (data) => {
  const res = await api('POST', '/api/staff/login', { email: data.email, password: data.password });
  if (res.ok) afterLogin(res.staff.role);
  else $('#loginForm').elements.password.value = '';
  return res;
});
// メールのリンク（#setup=合言葉）を開いた人: パスワードを自分で決める。合言葉は、アドレスの # より後ろにあるので、サーバーの記録には残らない
let setupToken = '';
onSubmit($('#setupForm'), async (data) => {
  if (data.password !== data.password2) return { ok: false, message: '入力を確かめてください', errors: { password2: '新しいパスワードが、2つの欄で違っています' } };
  const res = await api('POST', '/api/staff/setup', { token: setupToken, password: data.password });
  if (res.ok) { history.replaceState(null, '', location.pathname); afterLogin(res.staff.role); }
  return res;
});
// すでにこのページを開いているタブで、メールのリンクを開いたとき（アドレスの # だけが変わる）は、読み込み直す
addEventListener('hashchange', () => { if (/^#setup=/.test(location.hash)) location.reload(); });
// はじめての方: メールアドレスを入れると、パスワードを決めるためのメールが届く
onSubmit($('#requestForm'), async (data) => {
  const res = await api('POST', '/api/staff/setup/request', { email: data.email });
  if (res.ok) { const msg = $('.msg', $('#requestForm')); msg.textContent = 'スタッフとして登録されているアドレスであれば、メールをお送りしました。メールの中のリンクを開いて、パスワードを決めてください。'; msg.classList.add('ok'); }
  return res;
});
$('#firstTime').addEventListener('click', () => { $('#loginForm').hidden = true; $('#requestForm').hidden = false; $('#requestForm').elements.email.value = $('#loginForm').elements.email.value; $('#requestForm').elements.email.focus(); });
$('#backToLogin').addEventListener('click', () => { $('#requestForm').hidden = true; $('#loginForm').hidden = false; $('#loginForm').elements.email.focus(); });
(async () => {
  const state = await setupNav();
  me = state.staff;
  // メールのリンク（#setup=合言葉）から来た人には、パスワードを決める欄を出す
  const fromMail = /^#setup=([\w-]{20,200})$/.exec(location.hash);
  if (fromMail && !me) {
    $('#login').hidden = false; $('#loginForm').hidden = true;
    const who = await api('POST', '/api/staff/setup/check', { token: fromMail[1] });
    if (who.ok) {
      setupToken = fromMail[1];
      $('#setupWho').textContent = `${who.email}（${who.roleLabel}）のパスワードを決めます`;
      $('#setupForm').hidden = false; $('#setupForm').elements.password.focus();
    } else {
      $('#loginForm').hidden = false;
      const msg = $('.msg', $('#loginForm')); msg.textContent = who.message; msg.focus();
    }
    return;
  }
  if (!me) { $('#login').hidden = false; $('#loginForm').elements.email.focus(); return; }
  if (me.role === 'caller') { location.replace('/caller.html'); return; }
  // 「公開の前に入れておく項目」の帯は、画面を出す前に用意する（出したあとに差し込むと、中身が下にずれる。
  // Safari では、ずれる途中の描き直しが残り、帯が切れて見えた。報告書 98 章）
  if (me.role === 'admin') await releaseWarning();
  $('#app').hidden = false;
  $('#who').textContent = `${me.name}・${me.roleLabel}`;
  $('#myPassword').addEventListener('click', passwordDialog);
  // 競りの進行は、主催者管理者と進行役（8.14）
  $('#toConsole').hidden = !['admin', 'auctioneer'].includes(me.role);
  $('#toCaller').hidden = me.role !== 'admin';
  $('#toMonitor').hidden = me.role === 'operator'; // 会場の大型モニターは、会場にいるスタッフが開く
  const keys = Object.keys(PANELS).filter((k) => PANELS[k][2].includes(me.role));
  $('#tabs').replaceChildren(...keys.map((k) => el('button', { type: 'button', role: 'tab', id: `tab-${k}`, 'aria-controls': 'panel', 'data-key': k, text: PANELS[k][0], onclick: () => leavePanel(() => { pendingNotice = null; show(k); }) })));
  show(keys.includes(location.hash.slice(1)) ? location.hash.slice(1) : keys[0]);
})();

// 正式に公開する前に、埋めておくべきもの（規約類・返品特約の仮の文言・振込先）。主催者管理者に、上に出し続ける（報告書 80 章）
async function releaseWarning() {
  const [legal, settings] = await Promise.all([api('GET', '/api/legal'), api('GET', '/api/settings')]);
  if (!legal.ok || !settings.ok) return;
  const missing = [
    !legal.docs.terms.body && '利用規約', !legal.docs.privacy.body && 'プライバシーポリシー', !legal.docs.tokushoho.body && '特定商取引法に基づく表示',
    /【仮/.test(settings.returnPolicy ?? '') && '返品特約（仮の文言のまま）', !settings.bankAccount && '振込先', !settings.kobutsuLicense && '古物商の許可の表示',
  ].filter(Boolean);
  S_missing = missing; renderMissing();
  const text = `公開の前に、入れておく項目が ${missing.length} つあります`;
  const now = $('#releaseWarn');
  if (!missing.length) { now?.remove(); return; }
  // すでに出ていれば、数だけを書き換える（消して入れ直さない。描き直しで帯がちらつかないように）
  if (now) { now.querySelector('.notice__text').textContent = text; return; }
  // 1行だけ: 何件あるかと、直す場所への入口。中身は「設定」の上に出す（どのタブにも大きな赤字を出さない。報告書 83 章）
  $('#app').prepend(el('div', { class: 'notice', id: 'releaseWarn', role: 'status' }, el('span', { class: 'notice__icon', 'aria-hidden': 'true' }),
    el('span', { class: 'notice__text', text }),
    el('button', { class: 'textbtn', type: 'button', text: '設定を開く', onclick: () => leavePanel(() => { pendingNotice = null; show('settings'); }) })));
}
/** 「設定」の上に、まだ入っていない項目を並べる */
function renderMissing() {
  const box = $('#missingList'); if (!box) return;
  box.hidden = !S_missing.length;
  box.replaceChildren(el('b', { text: '公開の前に入れておく項目' }), el('ul', {}, S_missing.map((m) => el('li', { text: m }))));
}
tabKeys($('#tabs'));
