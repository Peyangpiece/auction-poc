// 管理画面: 会員（報告書 122 章で、staff.js から分けた。読み込む順番は staff.html のとおり。名前は、ファイルをまたいで共有する）
'use strict';

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
// 一覧の件数: 既定は新しい順の決まった件数。「さらに前の分も表示する」で倍に広げる（本番運用の評価 C）
const listLimits = {};
const withLimit = (url, key) => (listLimits[key] ? `${url}${url.includes('?') ? '&' : '?'}limit=${listLimits[key]}` : url);
function moreBtn(key, res, what) {
  if (!res.more) return null;
  return el('p', { class: 'note' }, `${what}は、新しい順に ${res.limit.toLocaleString()} 件（と、対応の残っているもの）を出しています。`,
    smallBtn('さらに前の分も表示する', () => { listLimits[key] = Math.min(50000, res.limit * 2); show(current); }));
}
let memberQuery = ''; // 会員を探す欄の中身（タブを離れても覚えておく）
async function membersPanel() {
  const res = await api('GET', withLimit('/api/members', 'members'));
  const waiting = res.members.filter((m) => !m.approved && !m.withdrawn).length;
  const rows = res.members.map((m) => el('tr', {},
    el('td', { class: 'n', text: String(m.id) }),
    // 区分の列はなくし、法人のときだけ名前の横に印を付ける（ほとんどが個人のため。報告書 83 章）
    el('td', { class: 'dyn' }, m.kind === 'b2b' ? [`${m.company}　${m.contactName}`, ' ', el('span', { class: 'tag', text: '法人' })] : m.name),
    el('td', { text: m.loginId ?? '' }),
    // 本人のものと確かめていない番号（メールで登録した人）には、印を付ける。同じ番号の申し込みがほかにもありうるため
    el('td', { class: 'n', text: telFmt(m.phone) + (m.phoneVerified || m.withdrawn ? '' : '（未確認）') }),
    el('td', { class: 'dyn', text: m.email + (m.emailVerified ? '' : '（未確認）') }),
    el('td', { class: 'dyn' }, m.rejected ? '承認しなかった' : m.withdrawn ? '退会' : !m.approved ? el('span', { class: 'warn', text: '承認待ち' }) : m.suspendedBy === 'manual' ? el('span', { class: 'warn', text: `停止中: ${m.suspendReason}` })
      : m.suspendedBy === 'unpaid' ? el('span', { class: 'warn', text: '未払いによる停止（消し込むと、自動で解ける）' }) : '利用中'),
    act(
      !m.approved && !m.withdrawn && smallBtn('承認する', () => issue(`/api/members/${m.id}/approve`, `会員 ${m.id} を承認しました`), 'btn-primary'),
      !m.approved && !m.withdrawn && smallBtn('承認しない', () => askReason(`会員 ${m.id} の登録を承認しない`, '理由', true, (reason) => api('POST', `/api/members/${m.id}/reject`, { reason }), '承認しない'), 'btn-danger'),
      m.approved && !m.withdrawn && smallBtn(m.loginId ? 'パスワードを再発行' : 'ログイン情報を発行', () => (m.loginId
        ? confirmDo(`会員 ${m.id} のパスワードを再発行しますか？`, 'いまのパスワードは使えなくなります。新しいパスワードを、本人へメールで送ります。', '再発行する',
          () => api('POST', `/api/members/${m.id}/credentials`), { danger: true, then: async (r) => { await show('members'); issuedDialog(`会員 ${m.id} のログイン情報を発行しました`, r); } })
        : issue(`/api/members/${m.id}/credentials`, `会員 ${m.id} のログイン情報を発行しました`))),
      !m.withdrawn && smallBtn('電話番号を変更', () => askForm(`会員 ${m.id} の電話番号を変更`, '',
        [field('新しい電話番号', 'phone', { type: 'tel', inputMode: 'tel', required: true }), field('本人を確かめた方法', 'reason', { required: true, placeholder: '会場で、運転免許証で確かめた' })], (d) => api('POST', `/api/members/${m.id}/phone`, d), '変更する')),
      m.suspendedBy === 'manual'
      ? smallBtn('停止を解く', () => post(`/api/members/${m.id}/unsuspend`))
      : !m.withdrawn && m.suspendedBy !== 'unpaid' && smallBtn('停止', () => askReason(`会員 ${m.id} を停止`, '停止の理由', true, (reason) => api('POST', `/api/members/${m.id}/suspend`, { reason }), '停止する'), 'btn-danger'))));
  const filterMembers = () => {
    const q = memberQuery.trim().toLowerCase().replace(/-/g, '');
    res.members.forEach((m, i) => { rows[i].hidden = !!q && ![String(m.id), m.name, m.company, m.contactName, m.loginId, String(m.phone ?? '').replace(/-/g, ''), m.email].some((v) => String(v ?? '').toLowerCase().includes(q)); });
  };
  filterMembers();
  return [el('p', { class: 'msg', id: 'line', role: 'alert' }),
    waiting ? el('div', { class: 'banner', role: 'status' }, el('span', { text: `承認待ちの会員登録が ${waiting} 件あります。承認すると、ログイン ID とパスワードが、本人へメールで送られます。` })) : null,
    // 探す欄: 会員番号・名前・ログイン ID・電話番号・メールの、どれかに含まれる行だけを出す（報告書 124 章）
    rows.length > 5 && el('div', { class: 'filters', role: 'search' }, el('label', { class: 'filter filter--wide' }, el('span', { text: '会員を探す' }),
      el('input', { class: 'input', type: 'search', placeholder: '会員番号・名前・電話番号・メール', 'aria-label': '会員番号・名前・電話番号・メールで探す', value: memberQuery, oninput: (ev) => { memberQuery = ev.target.value; filterMembers(); } }))),
    table(['会員番号', '名前', 'ログイン ID', '電話番号', 'メール', '状態', ''], rows, '会員はまだいません。'),
    moreBtn('members', res, '会員の一覧')];
}
