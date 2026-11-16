// 進行コンソールの動き。接続と時刻合わせは common.js
'use strict';
const $ = (id) => document.getElementById(id);
const S = { lots: new Map(), focus: null, history: [], stream: null, comments: [] };
// 一覧は、いちばん下を見ているときだけ新しい行に追従する
function follow(el, update) { const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24; update(); if (atEnd) el.scrollTop = el.scrollHeight; }
function renderComments() {
  follow($('comments'), () => $('comments').replaceChildren(...S.comments.map((c) => {
    const li = document.createElement('li');
    const who = document.createElement('span'); who.className = 'who num'; who.textContent = `${c.paddle}番`;
    const body = document.createElement('span'); body.className = 'dyn'; body.textContent = c.text;
    const hide = document.createElement('button'); hide.type = 'button'; hide.className = 'btn'; hide.textContent = '非表示';
    hide.setAttribute('aria-label', `${c.paddle}番のコメント「${c.text}」を非表示にする`);
    hide.onclick = () => cmd('hide_comment', { id: c.id });
    li.append(who, body, hide);
    return li;
  })));
}
const log = (text) => { const el = $('log'); follow(el, () => { el.textContent += `${jst(link ? link.serverNow() : Date.now())} ${text}\n`; }); };

function focusLot() { return S.lots.get(S.focus) ?? null; }
function setLamp(id, on, sub) {
  const el = $(id);
  el.className = on ? 'lamp on' : 'lamp';
  $(id + 'Sub').textContent = sub;
  el.setAttribute('aria-label', `${$(id + 'Label').textContent}、${on ? '点灯' : '消灯'}${sub ? '。' + sub : ''}`);
}
function render() {
  const lot = focusLot();
  const st = lot?.status;
  $('board').classList.toggle('idle', !lot);
  $('status').textContent = lot ? STATE_LABEL[st] + (lot.noVideo && st === 'open' ? '（映像なし）' : '') : '待機中';
  $('status').dataset.on = st === 'open' ? '1' : '';
  $('lotNo').textContent = lot ? `No.${lot.lotNo}` : '';
  $('title').textContent = lot ? lot.title : '進行中の品はありません';
  $('priceLabel').textContent = !lot ? '現在価格' : st === 'sold' ? '落札価格' : lot.currentPrice === null ? '開始価格' : '現在価格';
  $('price').textContent = lot ? yen(lot.currentPrice ?? lot.startPrice) : '';
  // 落札の条件は、うりきり（最低落札額に届いている）と、最高入札者がいることの両方
  setLamp('urikiri', !!lot?.urikiri, !lot || lot.reservePrice === null ? '' : `最低落札額 ${yen(lot.reservePrice)}`);
  setLamp('right', !!lot?.highestPaddle && st !== 'unsold', lot?.highestPaddle ? `${lot.highestPaddle}番` : '');
  const ended = st === 'sold' || st === 'unsold' || st === 'not_held';
  const next = [...S.lots.values()].find((l) => l.status === 'waiting'); // 出品順でいちばん先の、待機中の品
  // 板の案内は、進行役の判断に要ることだけ: 締めたらどうなるか、結果、配信が始まらないとき
  $('result').textContent = !lot ? (next ? '' : '品を追加してください')
    : st === 'sold' ? `${lot.highestPaddle}番 落札`
    : st === 'unsold' ? '流札'
    : st === 'open' ? (lot.urikiri && lot.currentPrice !== null ? `締めると ${lot.highestPaddle}番が落札` : '締めると流札')
    : st === 'preparing_warn' ? '配信が始まりません（60秒経過）'
    : '';
  // その状態でできる操作だけを出す
  const show = (id, on) => { $(id).hidden = !on; };
  // 締めた後・最初は、次にやることが1つだけ（次の品を開始）。板から目を離さずに進められる
  show('b_next', (!lot || ended) && !!next);
  if (next) { $('b_next').textContent = `No.${next.lotNo} を開始`; $('b_next').onclick = () => lotCmd('start', next.id); }
  show('b_close', st === 'open');
  show('b_suspend', st === 'open'); show('b_resume', st === 'suspended'); show('b_cancel', st === 'suspended');
  show('b_nv', st === 'preparing_warn'); show('b_back', st === 'preparing' || st === 'preparing_warn');

  const cell = (text, cls) => { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; return td; };
  follow($('histWrap'), () => $('history').replaceChildren(...S.history.map((h) => {
    const tr = document.createElement('tr');
    if (!h.valid) tr.className = 'void';
    tr.append(cell(h.seq, 'num'), cell(jst(h.received_at), 'num'), cell(`${h.paddle}番`, 'num'), cell(yen(h.amount), 'digits amt'), cell(h.valid ? '' : '無効'));
    return tr;
  })));
  $('histCount').textContent = `${S.history.filter((h) => h.valid).length}件`;

  const busy = [...S.lots.values()].some((l) => ['preparing', 'preparing_warn', 'open', 'suspended'].includes(l.status));
  const tb = $('lots'); tb.replaceChildren();
  for (const l of S.lots.values()) {
    const tr = document.createElement('tr');
    if (l.id === S.focus) tr.className = 'focus';
    tr.append(cell(l.lotNo, 'digits'), cell(l.title, 'dyn'), cell(yen(l.startPrice), 'num'), cell(l.reservePrice === null ? 'なし' : yen(l.reservePrice), 'num'), cell(STATE_LABEL[l.status]),
      cell(l.status === 'sold' ? `${l.highestPaddle}番 ${yen(l.currentPrice)}` : l.status === 'unsold' && l.currentPrice !== null ? '最低落札額に届かず' : '', 'num'));
    const td = document.createElement('td');
    if (l.status === 'waiting') {
      const b1 = document.createElement('button'); b1.type = 'button'; b1.textContent = '競り開始'; b1.className = 'btn'; b1.disabled = busy;
      if (busy) b1.title = '進行中の品を締めてから開始できます';
      b1.setAttribute('aria-label', `No.${l.lotNo} の競りを開始`);
      b1.onclick = () => lotCmd('start', l.id);
      const b2 = document.createElement('button'); b2.type = 'button'; b2.textContent = '除外…'; b2.className = 'btn';
      b2.setAttribute('aria-label', `No.${l.lotNo} を除外`);
      b2.onclick = () => lotCmd('exclude', l.id, true);
      td.append(b1, ' ', b2);
    }
    tr.appendChild(td); tb.appendChild(tr);
  }
}
function renderStream() {
  const s = S.stream; if (!s) return;
  $('s_live').textContent = s.mode === 'always-live' ? '常に LIVE とみなす' : s.live ? 'LIVE' : s.waiting ? 'LIVE を待っています' : '停止';
  $('s_live').dataset.on = s.live ? '1' : '';
  const yn = (v) => (v ? 'LIVE' : '未検出');
  $('s_by').textContent = `問い合わせ ${yn(s.liveBy.poll)}、イベント ${yn(s.liveBy.event)}` + (s.mode === 'mock' ? `、代役 ${yn(s.liveBy.mock)}` : '');
  $('s_agent').textContent = s.agentConnected ? '接続中' : '未接続'; $('s_agent').dataset.on = s.agentConnected ? '1' : '';
  $('s_obs').textContent = s.obsActive === null ? '不明' : s.obsActive ? '配信中' : '停止'; $('s_obs').dataset.on = s.obsActive ? '1' : '';
}
setInterval(() => {
  if (!link) return;
  $('clock').textContent = jst(link.serverNow());
  // 配信の止め忘れ: 競りがないまま配信が続いた時間が長くなったら知らせる（自動では止めない）
  const st = S.stream;
  const idleMs = st && st.idleSince && (st.obsActive || st.live) && st.mode !== 'always-live' ? link.serverNow() - st.idleSince : 0;
  $('idleWarn').textContent = st && idleMs >= st.idleWarnMs ? `競りがないまま ${Math.floor(idleMs / 60000)} 分、配信が続いています` : '';
  $('offset').textContent = link.offset.toFixed(1); $('rtt').textContent = link.rtt?.toFixed(1) ?? '0';
}, 50);

async function cmd(action, extra = {}) {
  const reqId = ++link.reqId, sent = localNow();
  const res = await link.request(reqId, { type: 'cmd', reqId, action, ...extra, clientSentAt: sent, clientSentAtCorrected: sent + link.offset });
  // うまくいかなかった操作は、記録の欄だけでなく、操作した場所のすぐ下にも理由を出す
  $('cmdMsg').textContent = !res ? '応答がありません' : res.ok ? '' : res.message;
  if (!res) log(`${action}: 応答なし`);
  else if (!res.ok) log(`${action}: 拒否（${res.message}）`);
  else log(`${action}: OK${res.status ? `（${STATE_LABEL[res.status]}${res.reason === 'reserve_not_met' ? '・最低落札額に届かず' : ''} ${res.paddle ?? ''} ${res.amount ? yen(res.amount) : ''}）` : ''} ${Math.round(res.clientRecvAt - sent)}ms`);
  return res;
}
// 確認と理由の入力は、ブラウザ標準の prompt / confirm ではなく、画面の中のダイアログで行う
function ask({ title, body, needReason = false, okLabel = '実行する', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('dlg');
    $('dlgTitle').textContent = title; $('dlgBody').textContent = body; $('dlgError').textContent = '';
    $('dlgReasonWrap').style.display = needReason ? 'grid' : 'none'; $('dlgReason').value = '';
    $('dlgOk').textContent = okLabel; $('dlgOk').className = danger ? 'btn btn-danger' : 'btn btn-primary';
    const done = (value) => { $('dlgForm').onsubmit = null; $('dlgCancel').onclick = null; dlg.oncancel = null; dlg.close(); resolve(value); };
    $('dlgForm').onsubmit = (ev) => {
      ev.preventDefault();
      const reason = $('dlgReason').value.trim();
      if (needReason && !reason) { $('dlgError').textContent = '理由を入力してください。'; $('dlgReason').focus(); return; }
      done({ reason });
    };
    $('dlgCancel').onclick = () => done(null);
    dlg.oncancel = (ev) => { ev.preventDefault(); done(null); };
    dlg.showModal();
    if (needReason) $('dlgReason').focus();
  });
}
const CONFIRM = {
  cancel: (l) => ({ title: `No.${l.lotNo} を取りやめますか？`, body: 'この品のすべての入札を無効にして、待機に戻します。入札の記録は残ります。', okLabel: '取りやめる', danger: true }),
  exclude: (l) => ({ title: `No.${l.lotNo} を除外しますか？`, body: 'この品は「未実施」になり、この開催では競りにかけられなくなります。', okLabel: '除外する', danger: true }),
};
async function lotCmd(action, lotId, needReason = false) {
  let reason = '';
  if (needReason) {
    const ans = await ask({ ...CONFIRM[action](S.lots.get(lotId)), needReason: true });
    if (!ans) return;
    reason = ans.reason;
  }
  return cmd(action, { lotId, reason });
}
document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
  const lot = focusLot(); if (!lot) return;
  b.disabled = true; // 二度押しを防ぐ（結果が届いたら元に戻す）
  await lotCmd(b.dataset.act, lot.id, !!b.dataset.reason);
  b.disabled = false; render();
}));
document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => cmd(b.dataset.cmd)));
document.querySelectorAll('[data-crash]').forEach((b) => b.addEventListener('click', async () => {
  const ans = await ask({ title: 'サーバーを強制終了しますか？', body: `${b.textContent.replace('…', '')}。参加者の画面は「再接続中」になり、受付中の品は復旧の規則に従って中断または確定になります。`, okLabel: '強制終了する', danger: true });
  if (ans) cmd('crash', { point: b.dataset.crash });
}));
document.querySelectorAll('[data-mark]').forEach((b) => b.addEventListener('click', () => cmd('mark', { label: $('markLabel').value || 'unnamed', phase: b.dataset.mark })));
$('markForm').addEventListener('submit', (ev) => ev.preventDefault());
$('addLot').addEventListener('submit', (ev) => { ev.preventDefault(); cmd('create_lot', { title: $('newTitle').value, startPrice: Number($('newPrice').value), reservePrice: $('newReserve').value === '' ? null : Number($('newReserve').value) }); });

function onMessage(msg, at) {
  switch (msg.type) {
    case 'welcome': case 'snapshot':
      S.lots = new Map(msg.lots.map((l) => [l.id, l])); S.focus = msg.focusLotId; S.history = msg.history; S.stream = msg.stream;
      S.comments = msg.comments ?? S.comments; renderComments();
      if (msg.type === 'welcome') {
        log(`接続しました（${msg.name}）`);
        document.querySelectorAll('[data-crash]').forEach((b) => { b.disabled = !msg.allowCrash; });
        if (!msg.allowCrash) $('crashNote').textContent = '障害の模擬は無効です（POC_ALLOW_CRASH=1 で有効）';
      }
      render(); renderStream(); break;
    case 'lot': {
      const prev = S.lots.get(msg.lot.id);
      S.lots.set(msg.lot.id, msg.lot);
      if (msg.lot.status !== 'waiting' && msg.lot.status !== 'not_held' && S.focus !== msg.lot.id) { S.focus = msg.lot.id; S.history = []; }
      if (prev && prev.status === 'suspended' && msg.lot.status === 'waiting') S.history.forEach((h) => { h.valid = 0; });
      if (prev && prev.status !== msg.lot.status) log(`No.${msg.lot.lotNo}: ${STATE_LABEL[prev.status]} → ${STATE_LABEL[msg.lot.status]}`);
      render(); break;
    }
    case 'price': {
      const lot = S.lots.get(msg.lotId);
      if (lot) Object.assign(lot, { currentPrice: msg.currentPrice, minBid: msg.minBid, highestPaddle: msg.paddle, urikiri: msg.urikiri });
      if (msg.lotId === S.focus) S.history.push({ seq: msg.seq, amount: msg.amount, received_at: msg.receivedAt, valid: 1, paddle: msg.paddle });
      render(); break;
    }
    case 'result':
      link.send({ type: 'result_ack', lotId: msg.lotId, at: at + link.offset, net: 'console' });
      S.lots.set(msg.lotId, msg.lot); render(); break;
    case 'stream': {
      const p = S.stream; S.stream = msg.stream;
      if (p && p.live !== msg.stream.live) log(`IVS: ${msg.stream.live ? 'LIVE になった' : 'LIVE でなくなった'}`);
      if (p && p.obsActive !== msg.stream.obsActive) log(`OBS: ${msg.stream.obsActive ? '配信開始' : '配信停止'}`);
      if (p && p.agentConnected !== msg.stream.agentConnected) log(`配信エージェント: ${msg.stream.agentConnected ? '接続' : '切断'}`);
      renderStream(); break;
    }
    case 'comment': S.comments.push(msg); if (S.comments.length > 30) S.comments.shift(); renderComments(); break;
    case 'comment_hidden': S.comments = S.comments.filter((c) => c.id !== msg.id); renderComments(); break;
    case 'presence': $('presence').textContent = msg.members; break;
    case 'error': log('エラー: ' + msg.message); break;
  }
}
let link = null;
const token = takeToken('auction-staff');
if (!token) { $('overlay').style.display = 'flex'; $('overlayText').textContent = '進行役用の URL を開き直してください'; }
else link = new Link({ token, label: 'console', onMessage, onStatus: (up, why) => { $('overlay').style.display = up ? 'none' : 'flex'; $('overlayText').textContent = why ?? '再接続中…'; } });
