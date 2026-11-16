// 入札画面の動き。接続と時刻合わせは common.js
'use strict';
const $ = (id) => document.getElementById(id);
const net = params.get('net') || 'unlabeled'; // 測定の区別用: ?net=wifi / 4g / 5g
const venue = params.get('mode') === 'venue'; // 会場参加は映像なし
$('net').textContent = net;
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
// 応札／観戦: 観戦の間は入札ボタンを押せない（誤って入札しないため）。最初は観戦にしておく
const S = { lots: new Map(), focus: null, paddle: null, history: [], stream: null, wasHighest: false, playerUrl: null, shownPrice: null, rendered: 0,
  mode: store.get('poc-mode', 'watch'), comments: [], cmtMax: 20, lockUntil: 0, connected: false, sound: false };
// 一覧は、いちばん下を見ているときだけ新しい行に追従する（読み返している途中で勝手に動かさない）
function follow(el, update) { const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24; update(); if (atEnd) el.scrollTop = el.scrollHeight; }
let link, audioCtx = null, wakeLock = null, player = null, playerLoading = false;

// ---- 文言（FR-BID-012）
const REJECT = {
  LOT_NOT_OPEN: () => 'この品は入札を受け付けていません',
  AFTER_CLOSE: () => '締めに間に合いませんでした',
  BELOW_MINIMUM: (r) => `価格が更新されました：最低入札額 ${yen(r.minBid)}`,
  OFF_LADDER: () => '入札できる金額ではありません',
  ALREADY_HIGHEST: () => 'あなたが最高入札者です',
  RATE_LIMITED: () => '入札が速すぎます。少し待ってから押してください',
  SUSPENDED: () => '参加が停止されています',
  NOT_JOINED: () => '参加手続きを済ませてください',
};
function say(text, kind = '') { $('msg').textContent = text; $('msg').dataset.kind = kind; }

// ---- 音・振動・画面を消さない機能
function beep() {
  if (!audioCtx) return 'no-context';
  if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
  const t = audioCtx.currentTime;
  for (const [i, f] of [880, 660, 880].entries()) {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0.5, t + i * 0.18); g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.18 + 0.16);
    o.start(t + i * 0.18); o.stop(t + i * 0.18 + 0.17);
  }
  return audioCtx.state;
}
async function requestWake() {
  if (!('wakeLock' in navigator)) { $('wake').textContent = '使えない（API なし）'; return 'unsupported'; }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    $('wake').textContent = '有効';
    wakeLock.addEventListener('release', () => { $('wake').textContent = '解除された'; });
    return 'active';
  } catch (err) {
    $('wake').textContent = '失敗: ' + err.name;
    return 'error:' + err.name;
  }
}

// ---- 表示
function focusLot() { return S.lots.get(S.focus) ?? null; }
/** ランプ: 点灯は塗りつぶし、消灯は輪郭。読み上げ用に、状態を言葉でも持たせる */
function setLamp(id, state, label, sub) {
  const el = $(id);
  el.className = 'lamp' + (state ? ' ' + state : '');
  $(id + 'Label').textContent = label;
  $(id + 'Sub').textContent = sub;
  el.setAttribute('aria-label', `${label}、${state ? '点灯' : '消灯'}${sub ? '。' + sub : ''}`);
}
function render() {
  const lot = focusLot();
  $('board').classList.toggle('idle', !lot);
  if (!lot) {
    $('lotNo').textContent = ''; $('title').textContent = '次の品をお待ちください';
    $('status').textContent = '待機中'; $('status').dataset.on = '';
    $('priceLabel').textContent = '現在価格'; $('price').textContent = ''; $('result').textContent = '';
    setLamp('urikiri', '', 'うりきり', ''); setLamp('right', '', '権利', '');
    $('bid').disabled = true; $('bid').textContent = '次の品をお待ちください'; S.shownPrice = null; return;
  }
  const st = lot.status;
  const mine = lot.highestPaddle !== null && lot.highestPaddle === S.paddle;
  const ended = st === 'sold' || st === 'unsold';
  $('lotNo').textContent = `No.${lot.lotNo}`;
  $('title').textContent = lot.title;
  $('status').textContent = STATE_LABEL[st] + (lot.noVideo && st === 'open' ? '（映像なし）' : '');
  $('status').dataset.on = st === 'open' ? '1' : '';
  $('priceLabel').textContent = st === 'sold' ? '落札価格' : lot.currentPrice === null ? '開始価格' : '現在価格';
  const price = lot.currentPrice ?? lot.startPrice;
  $('price').textContent = yen(price);
  if (S.shownPrice !== null && S.shownPrice !== price) { // 価格が動いたことを、短い動きで知らせる
    $('price').classList.add('tick'); setTimeout(() => $('price').classList.remove('tick'), 200);
  }
  S.shownPrice = price;

  // 「うりきり」: 最低落札額（公開）に届いていて、この価格で締めれば売れる。「権利」: 最高入札者。両方が点いた人が落札する
  const urikiri = !!lot.urikiri;
  // 最低落札額の金額は表示しない（端末にも届かない）。分かるのは、届いたかどうか（ランプ）だけ
  setLamp('urikiri', urikiri ? 'on' : '', 'うりきり', '');
  const holds = mine && st !== 'unsold';
  setLamp('right', holds ? (st === 'sold' ? 'won' : 'on') : '', holds && st === 'sold' ? '落札' : '権利',
    lot.highestPaddle === null ? '' : mine ? 'あなた' : `${lot.highestPaddle}番`);

  $('result').textContent = st === 'sold' ? (mine ? 'あなたが落札しました' : `${lot.highestPaddle}番 落札`) : st === 'unsold' ? '流札' : '';

  // 入札ボタン。観戦中は「応札に切り替える」ボタンとして働く（切り替えの場所を探させない）
  const watching = S.mode !== 'bid';
  const staff = S.paddle === null;
  const bid = $('bid');
  const canBid = st === 'open' && !mine && !watching;
  const canJoin = st === 'open' && watching && !staff;
  // 他の人の入札で金額が変わった直後は、短い間だけ押せなくする（古い金額のつもりで、新しい金額を押してしまうのを防ぐ）
  const locked = canBid && performance.now() < S.lockUntil;
  bid.dataset.action = canJoin ? 'join' : 'bid';
  bid.disabled = !(canBid || canJoin) || locked;
  bid.classList.toggle('locked', locked);
  bid.textContent = st !== 'open' ? (ended ? '次の品をお待ちください' : st === 'suspended' ? '中断しています' : '受付の開始をお待ちください')
    : staff ? 'スタッフは入札できません'
    : watching ? '応札に切り替える'
    : mine ? 'あなたが最高入札者です' : `${yen(lot.minBid)} で入札`;
  document.title = `${yen(price)} No.${lot.lotNo}｜株式会社NEWS ライブオークション`;
  S.wasHighest = mine && st === 'open';
}
function renderHistory() {
  // 受理された入札の全件を、受付連番の順のまま表示する。金額は全桁そのまま（隠さない・並べ替えない）
  const ul = $('history');
  const grew = S.history.length > S.rendered;
  follow(ul, () => ul.replaceChildren(...S.history.map((h, i) => {
    const li = document.createElement('li');
    li.className = [h.valid ? '' : 'void', h.paddle === S.paddle ? 'mine' : '', grew && i === S.history.length - 1 ? 'new' : ''].join(' ').trim();
    const cell = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };
    li.append(cell('who', `${h.paddle}番${h.paddle === S.paddle ? '（あなた）' : ''}`), cell('amt digits', yen(h.amount)), cell('at num', h.valid ? jstShort(h.received_at) : '無効'));
    return li;
  })));
  S.rendered = S.history.length;
  $('count').textContent = `${S.history.filter((h) => h.valid).length}件`;
}
function renderStream() {
  const show = $('showVideo').checked && !venue;
  $('videoBox').style.display = show ? 'block' : 'none';
  const live = !!S.stream?.live && !!S.stream?.playbackUrl;
  $('break').style.display = live ? 'none' : 'flex';
  $('breakTitle').textContent = S.stream?.live ? '映像を準備しています' : '映像は停止中です';
  renderSound();
  if (show && live) startPlayer(); else stopPlayer();
}

// ---- 応札／観戦の切り替え
function setMode(mode) {
  if (S.paddle === null) mode = 'watch'; // スタッフは入札できない
  S.mode = mode; store.set('poc-mode', mode);
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  render();
}
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); link?.event('mode', { mode: S.mode }); }));

// ---- コメント
function renderComments() {
  const on = $('cmtOn').checked;
  $('cmtBody').style.display = on ? 'grid' : 'none';
  if (!on) return;
  const ul = $('comments');
  follow(ul, () => ul.replaceChildren(...S.comments.map((c) => {
    const li = document.createElement('li');
    if (c.paddle === S.paddle) li.className = 'mine';
    const who = document.createElement('span'); who.className = 'who num'; who.textContent = `${c.paddle}番`;
    const body = document.createElement('span'); body.className = 'dyn'; body.textContent = c.text;
    li.append(who, body);
    return li;
  })));
}
$('cmtOn').checked = store.get('poc-comments', 'on') === 'on';
$('cmtOn').addEventListener('change', () => { store.set('poc-comments', $('cmtOn').checked ? 'on' : 'off'); renderComments(); });
const countComment = () => { $('cmtCount').textContent = `${[...$('cmtText').value].length}／${S.cmtMax}`; };
$('cmtText').addEventListener('input', countComment);
$('cmtForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const text = $('cmtText').value.trim();
  if (!text || !link) return;
  $('cmtSend').disabled = true;
  const reqId = ++link.reqId;
  const res = await link.request(reqId, { type: 'comment', reqId, text }, 5000);
  $('cmtSend').disabled = false;
  if (res?.ok) { $('cmtText').value = ''; $('cmtMsg').textContent = ''; countComment(); }
  else $('cmtMsg').textContent = res?.message ?? '送信できませんでした。通信を確かめて、もう一度お試しください。';
});

// ---- 映像（Amazon IVS の Web 用プレーヤー）
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
}
async function startPlayer() {
  if (player || playerLoading || document.hidden) return;
  playerLoading = true;
  try {
    if (!window.IVSPlayer) await loadScript(S.playerUrl);
    if (!IVSPlayer.isPlayerSupported) throw new Error('IVS プレーヤーに対応していないブラウザ');
    player = IVSPlayer.create();
    player.attachHTMLVideoElement($('video'));
    // 最初は消音で再生する（ブラウザは、操作なしに音つきの再生を始めさせない）。音は「音声を出す」を押してから出す
    player.setMuted(!S.sound);
    $('video').muted = !S.sound;
    player.addEventListener(IVSPlayer.PlayerEventType.ERROR, (e) => link.event('player_error', { type: e?.type, message: e?.message }));
    player.load(S.stream.playbackUrl);
    // 音つきの再生を断られたら、消音に戻して再生し直す（次に「音声を出す」を押せば出る）
    Promise.resolve(player.play()).catch(() => { S.sound = false; player.setMuted(true); $('video').muted = true; renderSound(); try { player.play(); } catch {} });
    link.event('player_start', { sound: S.sound });
  } catch (err) {
    $('latency').textContent = '再生できない: ' + err.message;
    link.event('player_error', { message: err.message });
  } finally { playerLoading = false; }
}
function renderSound() {
  const live = !!S.stream?.live && !!S.stream?.playbackUrl;
  $('sound').hidden = !(live && $('showVideo').checked && !venue);
  $('sound').textContent = S.sound ? '音声を消す' : '音声を出す';
  $('sound').setAttribute('aria-pressed', String(S.sound));
}
$('sound').addEventListener('click', () => {
  S.sound = !S.sound;
  if (player) { player.setMuted(!S.sound); $('video').muted = !S.sound; if (S.sound) { try { player.play(); } catch {} } }
  renderSound();
  link?.event('sound', { on: S.sound });
});
function stopPlayer() {
  if (!player) return;
  try { player.pause(); player.delete(); } catch {}
  player = null;
  $('latency').textContent = '未取得';
}
setInterval(() => {
  // 映像の遅延（ライブとの差）を5秒ごとにサーバーへ送る（POC-UI-006）。値が取れるかは【未検証】
  if (!player || document.hidden) return;
  let sec = null;
  try { sec = player.getLiveLatency(); } catch {}
  if (typeof sec === 'number' && isFinite(sec) && sec > 0) {
    $('latency').textContent = sec.toFixed(2) + ' 秒';
    link.send({ type: 'video_latency', latencyMs: Math.round(sec * 1000), at: link.serverNow(), net });
  } else $('latency').textContent = '取れない（時計の写真で比べる）';
}, 5000);

// ---- サーバーからのメッセージ
function onMessage(msg, at) {
  switch (msg.type) {
    case 'welcome': case 'snapshot':
      if (msg.type === 'welcome') {
        S.paddle = msg.paddle; S.playerUrl = msg.playerScriptUrl; $('me').textContent = msg.paddle === null ? 'スタッフ' : `${msg.paddle}番`;
        S.cmtMax = msg.commentMaxLength ?? 20; $('cmtText').maxLength = S.cmtMax; countComment();
        $('contact').textContent = msg.venueContact ? `会場連絡先：${msg.venueContact}` : '';
        document.querySelectorAll('.seg button').forEach((b) => { b.disabled = msg.paddle === null; });
        setMode(S.mode);
      }
      S.comments = msg.comments ?? S.comments;
      S.lots = new Map(msg.lots.map((l) => [l.id, l]));
      S.focus = msg.focusLotId; S.history = msg.history; S.stream = msg.stream; S.rendered = msg.history.length;
      render(); renderHistory(); renderStream(); renderComments();
      break;
    case 'comment':
      S.comments.push(msg); if (S.comments.length > 30) S.comments.shift();
      renderComments();
      break;
    case 'comment_hidden':
      S.comments = S.comments.filter((c) => c.id !== msg.id); renderComments();
      break;
    case 'lot': {
      const prev = S.lots.get(msg.lot.id);
      S.lots.set(msg.lot.id, msg.lot);
      if (msg.lot.status !== 'waiting' && msg.lot.status !== 'not_held') {
        if (S.focus !== msg.lot.id) { S.focus = msg.lot.id; S.history = []; S.rendered = 0; S.shownPrice = null; say(''); }
      }
      if (prev && prev.status === 'suspended' && msg.lot.status === 'waiting') S.history.forEach((h) => { h.valid = 0; }); // 取りやめ
      render(); renderHistory();
      break;
    }
    case 'price': {
      link.send({ type: 'price_ack', seq: msg.seq, at: at + link.offset, net }); // 受け取った時刻を送り返す（POC-SRV-008）
      const lot = S.lots.get(msg.lotId);
      if (!lot) break;
      const outbid = S.wasHighest && msg.paddle !== S.paddle && msg.lotId === S.focus;
      if (msg.paddle !== S.paddle && msg.lotId === S.focus) {
        if (!outbid) say(''); // 前の入札の結果は、もう今の状況ではない
        if (S.mode === 'bid' && lot.minBid !== msg.minBid) { S.lockUntil = performance.now() + 600; setTimeout(render, 620); }
      }
      Object.assign(lot, { currentPrice: msg.currentPrice, minBid: msg.minBid, highestPaddle: msg.paddle, urikiri: msg.urikiri });
      if (msg.lotId === S.focus) S.history.push({ seq: msg.seq, amount: msg.amount, received_at: msg.receivedAt, valid: 1, paddle: msg.paddle });
      render(); renderHistory();
      if (outbid) notifyOutbid(msg);
      break;
    }
    case 'result': {
      link.send({ type: 'result_ack', lotId: msg.lotId, at: at + link.offset, net });
      S.lots.set(msg.lotId, msg.lot);
      render();
      if (msg.lotId !== S.focus) break;
      const won = msg.status === 'sold' && msg.paddle === S.paddle;
      say(won ? `落札しました：${yen(msg.amount)}` : '', 'ok');
      $('alert').textContent = msg.status === 'sold' ? (won ? `あなたが ${yen(msg.amount)} で落札しました` : `${msg.paddle}番が ${yen(msg.amount)} で落札しました`) : '流札になりました';
      if (won) { beep(); if ('vibrate' in navigator) navigator.vibrate(300); }
      break;
    }
    case 'stream':
      S.stream = msg.stream; renderStream();
      break;
    case 'error':
      say(msg.message, 'ng');
      break;
  }
}
function notifyOutbid(msg) {
  // 上回られたら: 画面の色を変え、音を鳴らし、振動させる（FR-UI-004）
  document.body.classList.add('outbid');
  setTimeout(() => document.body.classList.remove('outbid'), 1500);
  const audio = beep();
  const vibrated = 'vibrate' in navigator ? navigator.vibrate([200, 100, 200]) : null;
  $('audio').textContent = audio; $('vib').textContent = vibrated === null ? '非対応' : String(vibrated);
  say(`上回られました：${msg.paddle}番 ${yen(msg.amount)}`, 'ng');
  $('alert').textContent = `上回られました。${msg.paddle}番が ${yen(msg.amount)}。次の入札額は ${yen(msg.minBid)}`;
  document.title = `上回られました｜${yen(msg.amount)}`;
  link.event('outbid_notify', { seq: msg.seq, audio, vibrated, hidden: document.hidden, wake: $('wake').textContent });
}

// ---- 入札（PoC ではボタンを押すだけ。最低入札額で入札する。POC-UI-002）
$('bid').addEventListener('click', async () => {
  const lot = focusLot();
  if (!lot) return;
  if ($('bid').dataset.action === 'join') { // 観戦中に押したら、まず応札に切り替えるだけ（この1回では入札しない）
    setMode('bid'); link.event('mode', { mode: 'bid', via: 'bid-button' });
    return;
  }
  $('bid').disabled = true;
  $('bid').textContent = '送信中…';
  const reqId = ++link.reqId, sent = localNow();
  const res = await link.request(reqId, { type: 'bid', reqId, lotId: lot.id, amount: lot.minBid, clientSentAt: sent, clientSentAtCorrected: sent + link.offset });
  if (!res) {
    say(link.up ? '応答がありません。価格を確かめてください' : '通信が切れました。入札が届いたかは、つながり直した後に確かめてください', 'ng');
    render(); return;
  }
  const shown = localNow();
  say(res.accepted ? `受理されました：${yen(res.amount)}` : (REJECT[res.code]?.(res) ?? res.code), res.accepted ? 'ok' : 'ng');
  Object.assign(lot, { currentPrice: res.currentPrice, minBid: res.minBid });
  if (res.accepted) lot.highestPaddle = S.paddle;
  if (typeof res.urikiri === 'boolean') lot.urikiri = res.urikiri;
  render();
  // ボタンを押してから、受理・拒否が画面に出るまで（P3-7）
  const ms = Math.round(shown - sent);
  $('lastRtt').textContent = `${ms} ms（${res.accepted ? '受理' : res.code}）`;
  link.event('bid_rtt', { ms, accepted: res.accepted, code: res.code, seq: res.seq, net });
});

// ---- タブを裏に回したとき・戻したとき（FR-STR-005、P3-6）
document.addEventListener('visibilitychange', () => {
  if (!link) return;
  link.event('visibility', { hidden: document.hidden });
  if (document.hidden) stopPlayer(); // 映像を止める
  else {
    requestWake(); // 画面を消さない機能は、裏に回ると解除されるので取り直す
    link.send({ type: 'sync' }); // 状態を取り直す
    renderStream(); // 映像は読み込み直して、最新の時点から再開する
  }
});
$('showVideo').addEventListener('change', renderStream);
new ResizeObserver(() => {
  const fixed = getComputedStyle($('board')).position === 'fixed';
  document.body.style.paddingBottom = fixed ? `${Math.ceil($('board').getBoundingClientRect().height) + 24}px` : '';
}).observe($('board'));
setInterval(() => {
  if (!link) return;
  $('clock').textContent = jst(link.serverNow());
  $('offset').textContent = link.offset.toFixed(1); $('rtt').textContent = link.rtt?.toFixed(1) ?? '0';
}, 50);

// ---- 入場（最初の1回のタップで、音を有効にする。FR-UI-004）
// 検証用の URL（合言葉つき）で開いたときは、そのまま入れる。合言葉がなければ、ログインと参加手続きを確かめる
const token = takeToken('auction-member');
let ready = !!token;
const getJson = async (url, body) => {
  try {
    const res = await fetch(url, body ? { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { credentials: 'same-origin' });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  } catch { return { status: 0, message: 'サーバーにつながりません。通信の状態を確かめて、開き直してください' }; }
};
const showPaddle = (title, paddle) => {
  $('gateEvent').replaceChildren(title, document.createElement('br'), '参加番号', Object.assign(document.createElement('b'), { textContent: String(paddle) }));
  $('join').hidden = true; $('enter').hidden = false; ready = true;
};
if (!token) (async () => {
  $('enter').hidden = true;
  const p = await getJson('/api/participation');
  if (p.status === 401) return location.replace('/login.html?next=bidder');
  if (p.status !== 200) { $('gateMsg').textContent = p.message ?? '開けませんでした。開き直してください'; return; }
  if (!p.event) { $('gateMsg').textContent = '開催中の競りはありません。'; return; }
  if (p.joined) return showPaddle(p.event.title, p.paddle);
  // 参加手続き: 受け取り方法と支払方法を、どちらも選ばれていない状態で聞く（FR-MODE-005）
  $('gateEvent').textContent = p.event.title;
  $('join').hidden = false;
  getJson('/api/terms').then((t) => { if (t.status === 200) $('joinTerms').textContent = `${t.shippingNotice}\n${t.returnPolicy}`; });
  $('join').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = new FormData($('join'));
    $('gateMsg').textContent = '';
    const res = await getJson('/api/join', { receive: data.get('receive'), payment: data.get('payment') });
    if (res.status === 200) showPaddle(p.event.title, res.paddle);
    else $('gateMsg').textContent = res.message ?? 'うまくいきませんでした。やり直してください';
  });
})();

$('enter').addEventListener('click', async () => {
  if (!ready) return;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); await audioCtx.resume(); beep(); } catch {}
  $('audio').textContent = audioCtx ? audioCtx.state : '使えない';
  $('vib').textContent = 'vibrate' in navigator ? '対応' : '非対応';
  $('gate').style.display = 'none';
  $('bid').textContent = '接続しています…';
  $('showVideo').checked = !venue; $('showVideo').disabled = venue;
  link = new Link({
    token, label: `bidder:${net}:${venue ? 'venue' : 'online'}`, onMessage,
    onStatus: (up, why, reconnected) => {
      $('overlay').style.display = up ? 'none' : 'flex';
      $('overlayText').textContent = why ?? '再接続中…';
      if (up && reconnected) say('つながり直しました');
    },
  });
  const wake = await requestWake();
  setTimeout(() => link.event('device', { ua: navigator.userAgent, wake, audio: audioCtx?.state ?? null, vibrate: 'vibrate' in navigator, net, venue }), 3000);
});
