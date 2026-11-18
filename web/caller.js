// オークショニアの画面の動き（発注者の指示。報告書 73 章）。接続と時刻合わせは common.js
// できること: 次の品の開始・開始値の設定（入札の前だけ）・うりきり・締め・流札。どのボタンも、押せないときは理由を、押したらどうなるかを、ボタンの中に書く
'use strict';
const $ = (id) => document.getElementById(id);
const S = { lots: new Map(), focus: null, history: [], ladder: null, busy: false, editing: false };

/** いま扱う品: 進行中の品。なければ、出品順でいちばん先の待機中の品（始まる前に、開始値を決められるように） */
function current() {
  const f = S.lots.get(S.focus);
  if (f && !['sold', 'unsold', 'not_held', 'waiting'].includes(f.status)) return f;
  const next = [...S.lots.values()].find((l) => l.status === 'waiting');
  return next ?? f ?? null;
}
const unitFor = (amount, lot) => {
  if (lot?.unit) return lot.unit;
  for (const band of S.ladder ?? [{ unit: 500 }]) if (band.lt === undefined || band.lt === null || amount < band.lt) return band.unit;
  return 500;
};
const parseAmount = (t) => { const d = String(t ?? '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, ''); return d ? Number(d) : null; };
const setInput = (n) => { $('startInput').value = n === null ? '' : n.toLocaleString('ja-JP'); };
const say = (text, kind = 'ng') => { $('msg').textContent = text; $('msg').dataset.kind = kind; };

function render() {
  const lot = current();
  const st = lot?.status ?? 'idle';
  const live = st === 'open' || st === 'suspended';
  const ended = st === 'sold' || st === 'unsold';
  const hasBid = !!lot && lot.currentPrice !== null;
  const bids = lot && lot.id === S.focus ? S.history.filter((h) => h.valid).length : 0;

  $('lotNo').textContent = lot ? `No.${lot.lotNo}` : '';
  $('title').textContent = lot ? lot.title : '品を待っています';
  $('status').textContent = !lot ? '待機中' : st === 'waiting' ? '次の品' : STATE_LABEL[st];
  $('status').dataset.st = st;
  $('priceLabel').textContent = !lot ? '現在価格' : st === 'sold' ? '落札価格' : hasBid ? '現在価格' : '開始価格';
  $('price').textContent = lot ? yen(lot.currentPrice ?? lot.startPrice) : '—';
  $('leader').textContent = lot?.highestPaddle ? `${lot.highestPaddle}番` : 'なし';
  $('bids').textContent = `${bids}件`;
  const urikiri = !!lot && (lot.reservePrice === null || lot.urikiri);
  // うりきりまで、あといくらか（入札がなければ、最低落札額そのもの）。オークショニアが、声をかける目安にする
  $('urikiriState').textContent = !lot ? '—' : urikiri ? '済み' : hasBid ? `あと${yen(lot.reservePrice - lot.currentPrice)}` : yen(lot.reservePrice);
  $('urikiriState').dataset.on = urikiri ? '1' : '';

  // 開始値: 入札の前だけ変えられる
  const canStart = !!lot && ['waiting', 'preparing', 'preparing_warn', 'open', 'suspended'].includes(st) && !hasBid && !S.busy;
  for (const id of ['stepDown', 'stepUp', 'setStart', 'startInput']) $(id).disabled = !canStart;
  $('startBox').classList.toggle('locked', !canStart && !S.busy);
  $('startNote').textContent = !lot ? '' : ended ? '終わった品です' : hasBid ? '入札があるので、変えられません' : `いまの開始値 ${yen(lot.startPrice)}`;
  if (!S.editing) setInput(canStart ? lot.startPrice : null);

  // うりきり: 最低落札額があり、まだ届いていないとき
  const canUrikiri = !!lot && !ended && ['waiting', 'preparing', 'preparing_warn', 'open', 'suspended'].includes(st) && !urikiri && !S.busy;
  $('urikiri').disabled = !canUrikiri;
  $('urikiriSub').textContent = !lot || ended ? '' : urikiri ? 'うりきり済み' : `最低落札額 ${yen(lot.reservePrice)} をなくす`;

  // 締め: 受付中のとき。押したらどうなるかを書く
  const willSell = hasBid && urikiri;
  // いちばん下の大きなボタン: 進行中の品がなければ「次の品を開始」、受付中なら「締め」（同じ場所で、次にやることが1つだけ出る）
  S.mode = st === 'waiting' ? 'start' : 'close';
  $('close').dataset.mode = S.mode;
  if (S.mode === 'start') {
    $('closeLabel').textContent = `No.${lot.lotNo} を開始`;
    $('closeSub').textContent = `${yen(lot.startPrice)} から入札を受け付けます${lot.reservePrice === null ? '（うりきり）' : ''}`;
    $('close').disabled = S.busy;
  } else {
    $('closeLabel').textContent = '締め';
    $('close').disabled = !(st === 'open') || S.busy;
    $('closeSub').textContent = st === 'open' ? (willSell ? `${lot.highestPaddle}番が ${yen(lot.currentPrice)} で落札` : `${hasBid ? '最低落札額に届かないので' : '入札がないので'}、流札になります`)
      : st === 'preparing' || st === 'preparing_warn' ? '映像の準備ができると、受付が始まります'
      : st === 'suspended' ? '中断中は締められません' : ended ? (st === 'sold' ? `${lot.highestPaddle}番 落札 済み` : '流札 済み') : '次の品がありません';
  }

  // 流札: 受付中・中断中で、うりきりの入札がないとき
  const canPass = live && !willSell && !S.busy;
  $('pass').disabled = !canPass;
  $('passSub').textContent = !live ? '' : willSell ? 'うりきりの入札があるので不可' : '売らずに、この品を終える';
}

async function cmd(action, extra = {}) {
  const lot = current();
  if (!lot || !link) return null;
  S.busy = true; render();
  const reqId = ++link.reqId, sent = localNow();
  const res = await link.request(reqId, { type: 'cmd', reqId, action, lotId: lot.id, ...extra, clientSentAt: sent, clientSentAtCorrected: sent + link.offset });
  S.busy = false;
  // 手ごたえ: 通ったら短く1回、通らなかったら2回ふるわせる（画面を見ていなくても分かる）
  if ('vibrate' in navigator) navigator.vibrate(res?.ok ? 20 : [30, 60, 30]);
  if (!res) say('応答がありません。通信を確かめて、もう一度押してください');
  else if (!res.ok) say(res.message);
  render();
  return res;
}

// 確かめのダイアログ（取り消せない操作だけ）。「やめる」は左、実行は右
function ask({ title, body, okLabel, danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('dlg');
    $('dlgTitle').textContent = title; $('dlgBody').textContent = body;
    $('dlgOk').textContent = okLabel; $('dlgOk').className = danger ? 'btn btn-danger' : 'btn btn-primary';
    const done = (v) => { $('dlgForm').onsubmit = null; $('dlgCancel').onclick = null; dlg.oncancel = null; dlg.close(); resolve(v); };
    $('dlgForm').onsubmit = (ev) => { ev.preventDefault(); done(true); };
    $('dlgCancel').onclick = () => done(false);
    dlg.oncancel = (ev) => { ev.preventDefault(); done(false); };
    dlg.showModal();
    $('dlgCancel').focus(); // 誤って続けて押しても、実行されないように
  });
}

// ---- 開始値
const step = (dir) => {
  const lot = current();
  const now = parseAmount($('startInput').value) ?? lot?.startPrice ?? 0;
  const next = dir > 0 ? now + unitFor(now, lot) : now - unitFor(Math.max(1, now - 1), lot);
  if (next >= 1) { S.editing = true; setInput(next); }
};
$('stepDown').addEventListener('click', () => step(-1));
$('stepUp').addEventListener('click', () => step(1));
$('startInput').addEventListener('input', () => { S.editing = true; setInput(parseAmount($('startInput').value)); });
$('startInput').addEventListener('focus', () => { S.editing = true; $('startInput').select(); });
$('startForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const lot = current();
  const amount = parseAmount($('startInput').value);
  if (!amount) return say('開始値を入れてください');
  const res = await cmd('set_start', { amount });
  if (res?.ok) { S.editing = false; say(`No.${lot.lotNo} の開始値を ${yen(amount)} にしました`, 'ok'); render(); }
});

// ---- うりきり・締め・流札
$('urikiri').addEventListener('click', async () => {
  const lot = current();
  if (!lot || !(await ask({ title: 'うりきりにしますか？', body: `No.${lot.lotNo} の最低落札額 ${yen(lot.reservePrice)} をなくします。\nこれからの最高入札者に、必ず売ることになります。取り消せません。`, okLabel: 'うりきりにする' }))) return;
  const res = await cmd('urikiri');
  if (res?.ok) say(`No.${lot.lotNo} をうりきりにしました`, 'ok');
});
$('close').addEventListener('click', async () => {
  const lot = current();
  if (!lot) return;
  // 次の品を開始: 確かめは出さない（すぐ始めたいことが多く、始めたあとも中断・取りやめができるため）
  if (S.mode === 'start') {
    const res = await cmd('start');
    if (res?.ok) say(`No.${lot.lotNo} を開始しました`, 'ok');
    return;
  }
  const willSell = lot.currentPrice !== null && (lot.reservePrice === null || lot.urikiri);
  if (!(await ask({ title: '締めますか？', body: willSell ? `No.${lot.lotNo} を、${lot.highestPaddle}番が ${yen(lot.currentPrice)} で落札します。` : `No.${lot.lotNo} は、${lot.currentPrice === null ? '入札がないので' : '最低落札額に届かないので'}、流札になります。`, okLabel: '締める' }))) return;
  const res = await cmd('close');
  if (res?.ok) say(res.status === 'sold' ? `${res.paddle ?? lot.highestPaddle}番が落札しました` : '流札になりました', 'ok');
});
$('pass').addEventListener('click', async () => {
  const lot = current();
  if (!lot || !(await ask({ title: '流札にしますか？', body: `No.${lot.lotNo} を、売らずに終えます。取り消せません。`, okLabel: '流札にする', danger: true }))) return;
  const res = await cmd('pass');
  if (res?.ok) say('流札にしました', 'ok');
});

// ---- 接続
function onMessage(msg) {
  switch (msg.type) {
    case 'welcome': case 'snapshot':
      S.lots = new Map(msg.lots.map((l) => [l.id, l])); S.focus = msg.focusLotId; S.history = msg.history ?? [];
      if (msg.ladder) S.ladder = msg.ladder;
      render(); break;
    case 'lot': {
      const prev = S.lots.get(msg.lot.id);
      S.lots.set(msg.lot.id, msg.lot);
      if (msg.lot.status !== 'waiting' && msg.lot.status !== 'not_held' && S.focus !== msg.lot.id) { S.focus = msg.lot.id; S.history = []; }
      if (prev && prev.status === 'suspended' && msg.lot.status === 'waiting') S.history.forEach((h) => { h.valid = 0; });
      // 別の品に移ったら、開始値の書きかけは捨てる
      if (!prev || prev.id !== current()?.id || prev.startPrice !== msg.lot.startPrice) S.editing = false;
      render(); break;
    }
    case 'price': {
      const lot = S.lots.get(msg.lotId);
      if (lot) Object.assign(lot, { currentPrice: msg.currentPrice, minBid: msg.minBid, highestPaddle: msg.paddle, urikiri: msg.urikiri });
      if (msg.lotId === S.focus) S.history.push({ seq: msg.seq, amount: msg.amount, valid: 1, paddle: msg.paddle });
      S.editing = false;
      render(); break;
    }
    case 'bid_void': S.lots.set(msg.lot.id, msg.lot); S.history.forEach((h) => { if (h.seq === msg.seq) h.valid = 0; }); render(); break;
    case 'result': S.lots.set(msg.lotId, msg.lot); render(); break;
    case 'presence': $('presence').textContent = `参加者 ${msg.members}人`; break;
    case 'error': say(msg.message); break;
  }
}
setInterval(() => { if (link) $('clock').textContent = jst(link.serverNow()).slice(0, 5); }, 1000);

// 競りの最中に、スマホの画面が消えないようにする（対応している端末だけ。画面に戻ったら、取り直す）
let wake = null;
const keepAwake = async () => { try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wake = await navigator.wakeLock.request('screen'); } catch { /* 省電力の設定などで断られたら、そのまま */ } };
document.addEventListener('visibilitychange', keepAwake);
keepAwake();

let link = null;
const onStatus = (up, why) => { $('overlay').style.display = up ? 'none' : 'flex'; $('overlayText').textContent = why ?? '再接続中…'; };
fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json()).then((me) => {
  if (!me.staff) return location.replace('/staff.html?next=caller');
  if (!['admin', 'auctioneer', 'caller'].includes(me.staff.role)) { onStatus(false, 'この画面は、オークショニアと主催者管理者が使います'); return; }
  link = new Link({ token: null, as: 'console', label: 'caller', onMessage, onStatus });
}).catch(() => onStatus(false, 'サーバーにつながりません'));
render();
