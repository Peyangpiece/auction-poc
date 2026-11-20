// オークショニアの画面の動き（発注者の指示。報告書 73 章）。接続と時刻合わせは common.js
// できること: 次の品の開始・開始価格の設定（入札の前だけ）・うりきり・締め・流札・中断・再開。どのボタンも、押せないときは理由を、押したらどうなるかを、ボタンの中に書く
'use strict';
const $ = (id) => document.getElementById(id);
const S = { lots: new Map(), focus: null, history: [], ladder: null, busy: false, editing: false };

/** いま扱う品: 進行中の品。なければ、出品順でいちばん先の待機中の品（始まる前に、開始価格を決められるように） */
function current() {
  // 締めた・流札にした直後は、しばらくその品の結果を出し続ける（すぐ次の品に替わると、続けて押したときに次の品が始まってしまう。本番運用の評価 B14）
  if (S.holdLot && Date.now() < S.holdUntil && S.lots.get(S.holdLot)) return S.lots.get(S.holdLot);
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

// 競りの時間外: 本日の開催がない、または終わったうえで、扱う品がないとき（発注者の指示。報告書 87 章）
const WORKING = ['waiting', 'preparing', 'preparing_warn', 'open', 'suspended'];
function offHours() { return S.connected && (S.ended || !S.event) && ![...S.lots.values()].some((l) => WORKING.includes(l.status)); }
async function renderOffHours() {
  const off = offHours();
  $('offhours').hidden = !off; $('main').hidden = off; $('homeLink').hidden = !off;
  if (!off) return;
  $('suspend').hidden = true;
  $('offTitle').textContent = S.ended ? '本日の競りは終了しました' : '本日の競りはありません';
  // 次の開催（公開中の開催のうち、今日より後でいちばん早いもの）
  if (!S.schedule) S.schedule = await fetch('/api/schedule', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => null);
  const today = S.schedule?.today ?? '';
  const next = (S.schedule?.events ?? []).find((e) => e.startsAt.slice(0, 10) > today);
  $('offNext').hidden = !next;
  if (!next) return;
  const [y, m, dd] = next.startsAt.slice(0, 10).split('-').map(Number);
  $('offDate').textContent = `${m}月${dd}日（${'日月火水木金土'[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]}）`; // ほかの画面と同じ書き方
  $('offInfo').textContent = `${next.title}　${next.startsAt.slice(11, 16)}〜　${next.venueName}`;
}
function render() {
  renderOffHours();
  if (offHours()) return;
  const lot = current();
  const st = lot?.status ?? 'idle';
  const live = st === 'open' || st === 'suspended';
  const ended = st === 'sold' || st === 'unsold';
  const hasBid = !!lot && lot.currentPrice !== null;

  $('lotNo').textContent = lot ? `No.${lot.lotNo}` : '';
  $('title').textContent = lot ? lot.title : '品を待っています';
  $('status').textContent = !lot ? '待機中' : st === 'waiting' ? '次の品' : STATE_LABEL[st];
  $('status').dataset.st = st;
  $('priceLabel').textContent = !lot ? '現在価格' : st === 'sold' ? '落札額' : hasBid ? '現在価格' : '開始価格';
  $('price').textContent = !lot ? '—' : lot.startPending ? '未定' : yen(lot.currentPrice ?? lot.startPrice);
  $('leader').textContent = lot?.highestPaddle ? `${lot.highestPaddle}番` : 'なし';
  // うりきりのランプは、サーバーが決める（うりきりを押した・最低落札額に届いた。最低落札額の入力がない品は、押すまで点かない。報告書 89 章）
  const urikiri = !!lot && !!lot.urikiri;
  // うりきりまで、あといくらか（入札がなければ、最低落札額そのもの）。最低落札額がない品は「—」（うりきりを押すまで点かない）
  $('urikiriState').textContent = !lot ? '—' : urikiri ? '済み' : lot.reservePrice === null ? '—' : hasBid ? `あと${yen(lot.reservePrice - lot.currentPrice)}` : yen(lot.reservePrice);
  $('urikiriState').dataset.on = urikiri ? '1' : '';
  // 読み上げは、1か所の要約だけ（面の全体を読み上げると、入札のたびに細切れに何度も読まれる。報告書 81 章）
  const said = !lot ? '' : [`No.${lot.lotNo}`, $('status').textContent, $('price').textContent, lot.highestPaddle ? `${lot.highestPaddle}番` : ''].filter(Boolean).join('　');
  if (said !== S.lotSaid) { S.lotSaid = said; $('lotSay').textContent = said; }

  // 開始価格: 入札の前だけ変えられる
  const canStart = !!lot && ['waiting', 'preparing', 'preparing_warn', 'open', 'suspended'].includes(st) && !hasBid && !S.busy;
  for (const id of ['stepDown', 'stepUp', 'setStart', 'startInput']) $(id).disabled = !canStart;
  $('startBox').classList.toggle('locked', !canStart && !S.busy);
  if (!S.editing) setInput(canStart ? lot.startPrice : null);
  // 始まる前は「変更」を出さない。欄の金額が、そのまま下の「開始」に使われる（押し忘れで、古い金額で始まらないように）
  $('setStart').hidden = st === 'waiting';
  const typed = canStart && st === 'waiting' ? parseAmount($('startInput').value) : null;

  // うりきり: 最低落札額があり、まだ届いていないとき
  const canUrikiri = !!lot && !ended && ['waiting', 'preparing', 'preparing_warn', 'open', 'suspended'].includes(st) && !urikiri && !S.busy;
  $('urikiri').disabled = !canUrikiri;
  $('urikiriSub').textContent = '';

  // 締め: 受付中のとき。押したらどうなるかを書く
  const willSell = hasBid && urikiri;
  // いちばん下の大きなボタン: 進行中の品がなければ「次の品を開始」、受付中なら「締め」（同じ場所で、次にやることが1つだけ出る）
  // 中断（上の帯）: 受付中だけ。中断中は、いちばん下のボタンが「再開」になる
  $('suspend').hidden = st !== 'open';
  $('suspend').disabled = S.busy;
  const holding = !!S.holdLot && Date.now() < S.holdUntil && lot?.id === S.holdLot;
  S.mode = holding ? 'hold' : st === 'waiting' ? 'start' : st === 'suspended' ? 'resume' : 'close';
  $('close').dataset.mode = S.mode;
  if (S.mode === 'hold') {
    // 結果を見せているあいだは、押せない（数秒で、次の品の「開始」に替わる）
    $('closeLabel').textContent = st === 'sold' ? `${lot.highestPaddle}番 ${yen(lot.currentPrice)} 落札` : st === 'unsold' ? '流札' : '確定しました';
    $('closeSub').textContent = 'まもなく次の品へ';
    $('close').disabled = true;
  } else if (S.mode === 'resume') {
    $('closeLabel').textContent = '再開';
    $('closeSub').textContent = '';
    $('close').disabled = S.busy;
  } else if (S.mode === 'start' && S.event && !S.event.phase) {
    // 開催を始める前は、品を開始できない（進行コンソールの「開催を始める」が先。報告書 124 章）
    $('closeLabel').textContent = '開催を、まだ始めていません';
    $('closeSub').textContent = '進行コンソールの「開催を始める」のあとで';
    $('close').disabled = true;
  } else if (S.mode === 'start' && lot.startPending && !typed) {
    // 品名だけの品: 押すと、開始価格の入力のシートを開く
    $('closeLabel').textContent = '開始価格を入れて始める';
    $('closeSub').textContent = '';
    $('close').disabled = S.busy;
  } else if (S.mode === 'start') {
    $('closeLabel').textContent = `No.${lot.lotNo} を開始`;
    $('closeSub').textContent = yen(typed ?? lot.startPrice);
    $('close').disabled = S.busy;
  } else {
    $('closeLabel').textContent = '締め';
    $('close').disabled = !(st === 'open') || S.busy;
    // 締めは取り消せないので、押したときの結果だけを短く出す（説明の文は出さない）
    $('closeSub').textContent = st === 'open' ? (willSell ? `→ ${lot.highestPaddle}番 ${yen(lot.currentPrice)} 落札` : '→ 流札') : '';
  }

  // 流札: 受付中・中断中で、うりきりのランプが点いていないとき（点いていたら、締める。報告書 79 章）。押せない理由を、ボタンの中に出す
  const canPass = live && !urikiri && !S.busy;
  $('pass').disabled = !canPass;
  $('passSub').textContent = live && urikiri ? 'うりきり済み' : '';
  if (!holding) syncSheet();
}
/** 締め・流札のあと、結果を見せる時間 */
function holdResult(lotId) {
  S.holdLot = lotId; S.holdUntil = Date.now() + 3000;
  clearTimeout(S.holdTimer);
  S.holdTimer = setTimeout(() => { S.holdLot = null; render(); }, 3050);
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
  if (!res) say('通信が切れました。つながり直したあとの表示で、操作が通ったかを確かめてください');
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
    // 開いた直後は「実行」を押せなくする（背後のボタンと位置が重なるので、2度押しの2度目で実行されないように。本番運用の評価 B15）
    $('dlgOk').disabled = true;
    setTimeout(() => { $('dlgOk').disabled = false; }, 500);
  });
}

// ---- 開始価格
const step = (dir) => {
  const lot = current();
  const now = parseAmount($('startInput').value) ?? lot?.startPrice ?? 0;
  const next = dir > 0 ? now + unitFor(now, lot) : now - unitFor(Math.max(1, now - 1), lot);
  if (next >= 1) { S.editing = true; setInput(next); render(); }
};
$('stepDown').addEventListener('click', () => step(-1));
$('stepUp').addEventListener('click', () => step(1));
$('startInput').addEventListener('input', () => { S.editing = true; const n = parseAmount($('startInput').value); setKeepCaret($('startInput'), n === null ? '' : n.toLocaleString('ja-JP')); render(); });
$('startInput').addEventListener('focus', () => { S.editing = true; $('startInput').select(); });
$('startForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const amount = parseAmount($('startInput').value);
  if (!amount) return say('開始価格を入れてください');
  const res = await cmd('set_start', { amount });
  if (res?.ok) { S.editing = false; say(''); render(); }
});

// ---- うりきり・締め・流札
$('urikiri').addEventListener('click', async () => {
  const lot = current();
  const body = lot.reservePrice === null ? `No.${lot.lotNo}　うりきりのランプを点けます。締めると、最高入札者に落札します` : `No.${lot.lotNo}　最低落札額 ${yen(lot.reservePrice)} に届かなくても、締めると、最高入札者に落札します`;
  if (!lot || !(await ask({ title: 'うりきりにしますか？', body, okLabel: 'うりきりにする' }))) return;
  const res = await cmd('urikiri');
  if (res?.ok) say('');
});
$('close').addEventListener('click', async () => {
  const lot = current();
  if (!lot) return;
  // 次の品を開始: 確かめは出さない（すぐ始めたいことが多く、始めたあとも中断・取りやめができるため）
  if (S.mode === 'resume') {
    const res = await cmd('resume');
    if (res?.ok) say('');
    return;
  }
  if (S.mode === 'start') {
    // 欄の金額で始める（ボタンの小さな字と同じ金額）。品名だけの品で、欄が空なら、開始価格の入力のシートを開く
    const amount = parseAmount($('startInput').value);
    if (lot.startPending && !amount) { openSheet(lot, true); return; }
    const res = await cmd('start', amount && amount !== lot.startPrice ? { amount } : {});
    if (res?.ok) { S.editing = false; say(''); }
    return;
  }
  const willSell = lot.currentPrice !== null && !!lot.urikiri;
  if (!(await ask({ title: '締めますか？', body: willSell ? `No.${lot.lotNo}　${lot.highestPaddle}番 ${yen(lot.currentPrice)} 落札` : `No.${lot.lotNo}　流札`, okLabel: '締める' }))) return;
  holdResult(lot.id);
  const res = await cmd('close');
  if (res?.ok) say(''); else { S.holdLot = null; render(); }
});
$('pass').addEventListener('click', async () => {
  const lot = current();
  if (!lot || !(await ask({ title: '流札にしますか？', body: `No.${lot.lotNo}`, okLabel: '流札にする', danger: true }))) return;
  holdResult(lot.id);
  const res = await cmd('pass');
  if (res?.ok) say(''); else { S.holdLot = null; render(); }
});

// 中断: 確かめは出さない（すぐ止めたいときに使い、いちばん下の「再開」ですぐ戻せるため）
$('suspend').addEventListener('click', async () => {
  const lot = current();
  if (!lot) return;
  const res = await cmd('suspend');
  if (res?.ok) say('');
});

// ---- 開始価格の入力のシート: 品名だけの品が次の品になったら、自動で開く（1つの品につき1回。「あとで」で閉じたら、下のボタンから開き直す）
S.sheetShownFor = new Set();
function openSheet(lot, byUser = false) {
  const dlg = $('startSheet');
  $('sheetLot').textContent = `No.${lot.lotNo} ${lot.title}`;
  $('sheetMsg').textContent = '';
  $('sheetInput').value = '';
  dlg.dataset.lot = String(lot.id);
  if (!dlg.open) dlg.showModal();
  $('sheetInput').focus();
  if (!byUser && 'vibrate' in navigator) navigator.vibrate([15, 80, 15]); // 新しい品が来たことを、手に伝える
}
function syncSheet() {
  const lot = current();
  const dlg = $('startSheet');
  const pending = !!lot && lot.status === 'waiting' && lot.startPending;
  if (dlg.open && (!pending || dlg.dataset.lot !== String(lot.id))) dlg.close(); // ほかの所で始まった・決まったら閉じる
  if (pending && !S.sheetShownFor.has(lot.id) && !$('dlg').open) { S.sheetShownFor.add(lot.id); openSheet(lot); }
}
$('sheetInput').addEventListener('input', () => { const n = parseAmount($('sheetInput').value); setKeepCaret($('sheetInput'), n === null ? '' : n.toLocaleString('ja-JP')); $('sheetMsg').textContent = ''; });
$('sheetLater').addEventListener('click', () => $('startSheet').close());
$('sheetForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const lot = current();
  const amount = parseAmount($('sheetInput').value);
  if (!lot) return $('startSheet').close();
  if (!amount) { $('sheetMsg').textContent = '開始価格を入れてください'; $('sheetInput').focus(); return; }
  $('sheetGo').disabled = true;
  const res = await cmd('start', { amount });
  $('sheetGo').disabled = false;
  if (res?.ok) { $('startSheet').close(); say(''); }
  else $('sheetMsg').textContent = res?.message ?? '応答がありません。もう一度押してください';
});

// ---- 接続
function onMessage(msg) {
  switch (msg.type) {
    case 'welcome': case 'snapshot':
      // 開催が切り替わっていたら（前の開催の画面を開いたままだった）、読み込み直して、最初からにする
      if (reloadOnNewEvent(S, msg)) return;
      S.lots = new Map(msg.lots.map((l) => [l.id, l])); S.focus = msg.focusLotId; S.history = msg.history ?? [];
      S.connected = true; S.event = msg.event ?? null; S.ended = !msg.event && !!msg.ended;
      if (msg.ladder) S.ladder = msg.ladder;
      render(); break;
    case 'lot': {
      const prev = S.lots.get(msg.lot.id);
      S.lots.set(msg.lot.id, msg.lot);
      if (msg.lot.status !== 'waiting' && msg.lot.status !== 'not_held' && S.focus !== msg.lot.id) { S.focus = msg.lot.id; S.history = []; }
      if (prev && prev.status === 'suspended' && msg.lot.status === 'waiting') S.history.forEach((h) => { h.valid = 0; });
      // 別の品に移ったら、開始価格の書きかけは捨てる
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
    case 'event': S.event = msg.event ?? null; S.ended = !msg.event && !!msg.ended; S.schedule = null; render(); break;
    case 'presence': $('presence').textContent = `参加者 ${msg.members}人`; break;
    case 'error': say(msg.message); break;
  }
}

// 競りの最中に、スマホの画面が消えないようにする（対応している端末だけ。画面に戻ったら、取り直す）
let wake = null;
const keepAwake = async () => { try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wake = await navigator.wakeLock.request('screen'); } catch { /* 省電力の設定などで断られたら、そのまま */ } };
document.addEventListener('visibilitychange', keepAwake);
keepAwake();

let link = null;
const onStatus = (up, why, _r, code) => showOverlay(up, why, code, 'caller');
fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json()).then((me) => {
  if (!me.staff) return location.replace('/staff.html?next=caller');
  if (!['admin', 'auctioneer', 'caller'].includes(me.staff.role)) { onStatus(false, 'この画面は、オークショニア・進行役・主催者管理者が使います', false, 'FORBIDDEN'); return; }
  link = new Link({ token: null, as: 'console', label: 'caller', onMessage, onStatus });
}).catch(() => onStatus(false, 'サーバーにつながりません'));
render();
