// 進行コンソールの動き。接続と時刻合わせは common.js
'use strict';
const $ = (id) => document.getElementById(id);
const S = { lots: new Map(), focus: null, history: [], stream: null, comments: [], event: null, sold: [] };
// 一覧は、いちばん下を見ているときだけ新しい行に追従する
// 末尾を見ていたら、更新のあとも末尾を見せる。末尾へ送るのは、描き直しのあとの1回だけ（読み取りと書き込みを交互にしない。報告書 82 章）
function follow(el, update) { const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24; update(); if (atEnd) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; }); }
function renderComments() {
  follow($('comments'), () => $('comments').replaceChildren(...S.comments.map((c) => {
    const li = document.createElement('li');
    const who = document.createElement('span'); who.className = 'who num'; who.textContent = `${c.paddle}番`;
    const body = document.createElement('span'); body.className = 'dyn'; body.textContent = c.text;
    const hide = document.createElement('button'); hide.type = 'button'; hide.className = 'btn'; hide.textContent = '非表示';
    hide.setAttribute('aria-label', `${c.paddle}番のコメント「${c.text}」を非表示にする`);
    hide.onclick = async () => { if (await ask({ title: 'コメントを非表示にしますか？', body: `${c.paddle}番「${c.text}」。参加者の画面から消えます。元には戻せません。`, okLabel: '非表示にする', danger: true })) cmd('hide_comment', { id: c.id }); };
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
  $('status').dataset.st = st ?? 'idle';
  $('lotNo').textContent = lot ? `No.${lot.lotNo}` : '';
  $('title').textContent = lot ? lot.title : '進行中の品はありません';
  $('priceLabel').textContent = !lot ? '現在価格' : st === 'sold' ? '落札額' : lot.currentPrice === null ? '開始価格' : '現在価格';
  $('price').textContent = lot ? yen(lot.currentPrice ?? lot.startPrice) : '';
  // 落札の条件は、うりきり（最低落札額に届いている）と、最高入札者がいることの両方
  setLamp('urikiri', !!lot?.urikiri, !lot || lot.reservePrice === null ? '' : `最低落札額 ${yen(lot.reservePrice)}`);
  setLamp('right', !!lot?.highestPaddle && st !== 'unsold', lot?.highestPaddle ? `${lot.highestPaddle}番` : '');
  const ended = st === 'sold' || st === 'unsold' || st === 'not_held';
  const next = [...S.lots.values()].find((l) => l.status === 'waiting'); // 出品順でいちばん先の、待機中の品
  // 板の案内は、進行役の判断に要ることだけ: 締めたらどうなるか、結果、配信が始まらないとき
  $('result').textContent = !lot ? (next ? '' : '品を追加してください')
    : st === 'sold' ? `${lot.highestPaddle}番 落札`
    : st === 'unsold' ? '' // 流札は、状態の札に出ている（同じ言葉を2度出さない）
    : st === 'open' ? (lot.urikiri && lot.currentPrice !== null ? `締めると ${lot.highestPaddle}番が落札` : '締めると流札')
    : st === 'preparing_warn' ? '配信が始まりません（60秒経過）'
    : '';
  // 読み上げは、1か所の要約だけ（価格・ランプ・結果が別々に読まれて細切れにならないように。報告書 81 章）
  const summary = !lot ? '' : [`No.${lot.lotNo}`, STATE_LABEL[st] ?? '', yen(lot.currentPrice ?? lot.startPrice), lot.highestPaddle ? `${lot.highestPaddle}番` : '', $('result').textContent].filter(Boolean).join('　');
  if (summary !== S.boardSaid) { S.boardSaid = summary; $('boardSay').textContent = summary; }
  // その状態でできる操作だけを出す
  const show = (id, on) => { $(id).hidden = !on; };
  // 締めた後・最初は、次にやることが1つだけ（次の品を開始）。板から目を離さずに進められる
  show('b_next', (!lot || ended) && !!next);
  // 開始価格が未定の品（品名だけで登録した品）は、オークショニアの画面で開始価格を入れて始める
  if (next) { $('b_next').textContent = next.startPending ? `No.${next.lotNo} は、オークショニアの開始価格の入力待ち` : `No.${next.lotNo} を開始`; $('b_next').disabled = !!next.startPending; $('b_next').onclick = () => lotCmd('start', next.id); }
  // 開催を始める前は、品を開始できない（「開催を始める」を先に押す）
  if (next && S.event && !S.event.phase) { $('b_next').textContent = `「開催を始める」を押すと、No.${next.lotNo} を開始できます`; $('b_next').disabled = true; }
  show('b_close', st === 'open');
  // うりきり: ランプが消えている品だけ（最低落札額の入力がない品は、押すまで点かない。報告書 89 章）
  show('b_urikiri', !!lot && ['waiting', 'preparing', 'preparing_warn', 'open', 'suspended'].includes(st) && !lot.urikiri);
  show('b_suspend', st === 'open'); show('b_resume', st === 'suspended'); show('b_cancel', st === 'suspended');
  show('b_nv', st === 'preparing_warn'); show('b_back', st === 'preparing' || st === 'preparing_warn');

  const cell = (text, cls) => { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; return td; };
  const lastValid = [...S.history].reverse().find((h) => h.valid);
  follow($('histWrap'), () => $('history').replaceChildren(...S.history.map((h) => {
    const tr = document.createElement('tr');
    if (!h.valid) tr.className = 'void';
    // 代理入札には「代理」と出す（FR-BID-008）
    const state = cell(h.valid ? '' : '無効');
    // 受付の順は、行の並びで分かるので、受付連番の列は出さない。千分の一秒は、検証用の設定のときだけ（報告書 88 章）
    tr.append(cell(S.dev ? jst(h.received_at) : jst(h.received_at).slice(0, 8), 'num'), cell(`${h.paddle}番${h.proxy ? '（代理）' : ''}`, 'num'), cell(yen(h.amount), 'digits amt'), state);
    // 取り消せるのは、いちばん新しい有効な入札が代理入札で、まだ締めていないときだけ（FR-CON-006）
    if (h.proxy && h.valid && h === lastValid && (st === 'open' || st === 'suspended')) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn btn-danger'; b.textContent = '代理入札を取り消す…';
      b.onclick = async () => {
        const ans = await ask({ title: '代理入札を取り消しますか？', body: `${h.paddle}番の ${yen(h.amount)} を無効にして、1つ前の入札に戻します。`, needReason: true, okLabel: '取り消す', danger: true });
        if (ans) cmd('proxy_cancel', { lotId: S.focus, bidSeq: h.seq, reason: ans.reason });
      };
      state.append(b);
    }
    return tr;
  })));
  $('histCount').textContent = `${S.history.filter((h) => h.valid).length}件`;

  const busy = [...S.lots.values()].some((l) => ['preparing', 'preparing_warn', 'open', 'suspended'].includes(l.status));
  $('homeLink').hidden = busy;
  // 出品一覧は、表ではなく行の一覧（1行目に番号と品名、2行目に価格と状態）。押せるのは、待機中の品の「開始」と「…」の除外だけ。
  // ほかの品が進行中のあいだは、押せないボタンを並べない（「進行中の品を締めると、開始できます」と一度だけ出す）
  const items = [...S.lots.values()];
  $('lotsCount').textContent = items.length ? `${items.filter((l) => l.status === 'waiting').length}件 待機／全${items.length}件` : '';
  $('lots').replaceChildren(...(items.length ? items.map((l) => {
    const li = document.createElement('li');
    if (l.id === S.focus) li.className = 'focus';
    const no = document.createElement('span'); no.className = 'lotlist__no digits'; no.textContent = l.lotNo;
    const main = document.createElement('span'); main.className = 'lotlist__main';
    const name = document.createElement('b'); name.className = 'dyn'; name.textContent = l.title;
    const sub = document.createElement('span'); sub.className = 'lotlist__sub num';
    const result = l.status === 'sold' ? `${l.highestPaddle}番 ${yen(l.currentPrice)} で落札` : l.status === 'unsold' && l.currentPrice !== null ? '最低落札額に届かず流札' : '';
    sub.textContent = [l.startPending ? '開始価格 未定（オークショニアが決める）' : `開始 ${yen(l.startPrice)}`, l.reservePrice === null ? '' : `最低落札額 ${yen(l.reservePrice)}`, result].filter(Boolean).join('・');
    main.append(name, sub);
    const tag = document.createElement('span'); tag.className = 'pill'; tag.dataset.st = l.status; tag.textContent = STATE_LABEL[l.status];
    li.append(no, main, tag);
    if (l.status === 'waiting' && !busy && !l.startPending) { // 開始価格が未定の品は、オークショニアの画面から始める
      const b1 = document.createElement('button'); b1.type = 'button'; b1.textContent = '開始'; b1.className = 'btn';
      b1.setAttribute('aria-label', `No.${l.lotNo} の競りを開始`);
      b1.onclick = () => lotCmd('start', l.id);
      li.append(b1);
    }
    if (l.status === 'waiting') {
      const b2 = document.createElement('button'); b2.type = 'button'; b2.className = 'iconbtn'; b2.textContent = '除外…';
      b2.setAttribute('aria-label', `No.${l.lotNo} を除外`);
      b2.onclick = () => lotCmd('exclude', l.id, true);
      li.append(b2);
    }
    return li;
  }) : [Object.assign(document.createElement('li'), { className: 'lotlist__empty', textContent: '品はまだありません。下の欄から追加してください。' })]));
}
function renderStream() {
  const s = S.stream; if (!s) return;
  // 映像をつないでいないとき（競りだけを動かす設定）は、配信の欄を出さない
  $('streamBox').hidden = s.mode === 'always-live';
  $('s_live').textContent = s.mode === 'always-live' ? '常に LIVE とみなす' : s.live ? 'LIVE' : s.waiting ? 'LIVE を待っています' : '停止';
  $('s_live').dataset.on = s.live ? '1' : '';
  const yn = (v) => (v ? 'LIVE' : '未検出');
  $('s_by').textContent = `問い合わせ ${yn(s.liveBy.poll)}、イベント ${yn(s.liveBy.event)}` + (s.mode === 'mock' ? `、代役 ${yn(s.liveBy.mock)}` : '');
  $('s_agent').textContent = s.agentConnected ? '接続中' : '未接続'; $('s_agent').dataset.on = s.agentConnected ? '1' : '';
  $('s_obs').textContent = s.obsActive === null ? '不明' : s.obsActive ? '配信中' : '停止'; $('s_obs').dataset.on = s.obsActive ? '1' : '';
  renderCameras(s);
  renderView(s);
  // OBS の出力解像度（報告書 93 章）。決めた大きさ（既定 960×720）でないときは、理由と直し方を出す
  const v = s.agentConnected ? s.video : null;
  const px = (a) => (a ? `${a[0]}×${a[1]}` : '—');
  $('s_video').textContent = px(v?.output);
  const off = v && v.want && (v.output?.[0] !== v.want[0] || v.output?.[1] !== v.want[1]);
  $('videoWarn').textContent = !off ? ''
    : v.state === 'streaming' ? `配信が止まったら、${px(v.want)} にそろえます。`
    : v.state === 'base_aspect' ? `OBS の基本解像度（${px(v.base)}）の縦横の比が ${px(v.want)} と違うため、出力をそろえられません。OBS の「設定 → 映像」で、基本解像度を 4:3（例: 1440×1080）にしてください。`
    : '';
}
// ---- オンライン参加者と同じ映像（IVS のプレーヤーで再生。報告書 101 章）
let viewPlayer = null, viewLoading = false, viewSound = false;
function renderView(s) {
  $('viewBox').hidden = s.mode === 'always-live' || !s.playbackUrl; // 映像をつないでいない設定では、枠ごと出さない
  const live = !!s.live && !!s.playbackUrl && !document.hidden;
  $('viewOff').hidden = !!s.live;
  if (!s.live) $('viewOff').textContent = '映像は停止中です';
  $('viewSound').hidden = !s.live;
  if (live) startView(s.playbackUrl); else stopView();
}
async function startView(url) {
  if (viewPlayer || viewLoading) return;
  viewLoading = true;
  try {
    if (!window.IVSPlayer) await new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = S.playerUrl; sc.onload = res; sc.onerror = () => rej(new Error('映像の再生の部品を読み込めませんでした。通信を確かめてください')); document.head.appendChild(sc); });
    if (!IVSPlayer.isPlayerSupported) throw new Error('このブラウザは、映像の再生に対応していません');
    viewPlayer = IVSPlayer.create();
    viewPlayer.attachHTMLVideoElement($('viewVideo'));
    viewPlayer.setMuted(!viewSound);
    viewPlayer.load(url);
    Promise.resolve(viewPlayer.play()).catch(() => { viewSound = false; viewPlayer.setMuted(true); renderViewSound(); try { viewPlayer.play(); } catch {} });
  } catch (err) {
    $('viewOff').hidden = false; $('viewOff').textContent = err.message;
  } finally { viewLoading = false; }
}
function stopView() {
  if (!viewPlayer) return;
  try { viewPlayer.pause(); viewPlayer.delete(); } catch {}
  viewPlayer = null;
}
// 画面を裏にしているあいだは、映像を止める（通信と電池を使わない）。表に戻したら、また再生する
document.addEventListener('visibilitychange', () => { if (S.stream) renderView(S.stream); });
function renderViewSound() { $('viewSound').textContent = viewSound ? '音声を消す' : '音声を出す'; $('viewSound').setAttribute('aria-pressed', String(viewSound)); }
$('viewSound').addEventListener('click', () => {
  viewSound = !viewSound;
  if (viewPlayer) { viewPlayer.setMuted(!viewSound); if (viewSound) { try { viewPlayer.play(); } catch {} } }
  renderViewSound();
});

// 映すカメラの切り替え（報告書 92 章）。「カメラ: スマホ」なら「スマホ」と出す
const camLabel = (name) => name.replace(/^カメラ[\s:：・]*/, '') || name;
function renderCameras(s) {
  const cams = s.cameras ?? [];
  $('cameraBox').hidden = !s.agentConnected;
  $('camNone').hidden = cams.length > 0;
  const key = JSON.stringify([cams, s.camera]);
  if ($('cameras').dataset.key === key) return; // 変わったときだけ描き直す（押している最中のフォーカスを失わない）
  $('cameras').dataset.key = key;
  const focused = document.activeElement?.dataset?.camera;
  $('cameras').replaceChildren(...cams.map((name) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'btn camopt', textContent: camLabel(name) });
    b.dataset.camera = name;
    b.setAttribute('aria-pressed', String(name === s.camera));
    b.onclick = async () => {
      if (name === S.stream?.camera) return;
      b.disabled = true;
      await cmd('camera', { camera: name }, 'camMsg');
      b.disabled = false;
    };
    return b;
  }));
  if (focused) $('cameras').querySelector(`[data-camera="${CSS.escape(focused)}"]`)?.focus();
}
setInterval(() => {
  if (!link) return;
  // 千分の一秒までの時刻は、遅延を測るとき（検証用の設定）だけ出す
  const setText = (id, t) => { if ($(id).textContent !== t) $(id).textContent = t; }; // 変わったときだけ書く（読み上げの繰り返しと、無駄な描き直しを避ける）
  setText('clock', S.dev ? jst(link.serverNow()) : jst(link.serverNow()).slice(0, 8));
  // 開催を始めてからの経過時間（休憩のあいだも進む）
  const from = S.event?.startedAt ?? null;
  $('elapsed').hidden = !from;
  if (from) { const sec = Math.max(0, Math.floor((link.serverNow() - from) / 1000)); setText('elapsedTime', `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`); }
  // 配信の止め忘れ: 競りがないまま配信が続いた時間が長くなったら知らせる（自動では止めない）
  const st = S.stream;
  const idleMs = st && st.idleSince && (st.obsActive || st.live) && st.mode !== 'always-live' ? link.serverNow() - st.idleSince : 0;
  setText('idleWarn', st && idleMs >= st.idleWarnMs ? `競りがないまま ${Math.floor(idleMs / 60000)} 分、配信が続いています` : '');
  setText('offset', link.offset.toFixed(1)); setText('rtt', link.rtt?.toFixed(1) ?? '0');
}, 50);

const ACTION_TEXT = {
  start: '開始', start_without_video: '映像なしで開始', back_to_waiting: '待機に戻す', close: '締め', suspend: '中断', resume: '再開', cancel: '取りやめ', exclude: '除外',
  create_lot: '品を追加', proxy_bid: '代理入札', proxy_cancel: '代理入札の取り消し', hide_comment: 'コメントを非表示', event_break: '休憩に入る', event_end: '開催終了',
  stream_start: '配信を開始', stream_stop: '配信を停止', camera: 'カメラの切り替え', stream_status: '配信の状態の問い合わせ', mark: '測定の印', crash: '強制終了（模擬）',
};
async function cmd(action, extra = {}, msgId = 'cmdMsg') {
  const reqId = ++link.reqId, sent = localNow();
  const res = await link.request(reqId, { type: 'cmd', reqId, action, ...extra, clientSentAt: sent, clientSentAtCorrected: sent + link.offset });
  // うまくいかなかった操作は、記録の欄だけでなく、操作した場所のすぐ下にも理由を出す（代理入札は、代理入札の欄の下）
  $(msgId).textContent = !res ? '通信が切れました。つながり直したあとの表示で、操作が通ったかを確かめてください' : res.ok ? '' : res.message;
  // 操作の記録は、読める言葉で（内部の名前のままにしない。報告書 82 章）。かかった時間は、検証用の設定のときだけ
  const name = ACTION_TEXT[action] ?? action;
  if (!res) log(`${name}: 応答なし`);
  else if (!res.ok) log(`${name}: できませんでした（${res.message}）`);
  else log(`${name}${res.status ? `（${STATE_LABEL[res.status]}${res.reason === 'reserve_not_met' ? '・最低落札額に届かず' : ''}${res.paddle ? ` ${res.paddle}番` : ''}${res.amount ? ` ${yen(res.amount)}` : ''}）` : ''}${S.dev ? ` ${Math.round(res.clientRecvAt - sent)}ms` : ''}`);
  return res;
}
// 確認と理由の入力は、ブラウザ標準の prompt / confirm ではなく、画面の中のダイアログで行う
function ask({ title, body, needReason = false, okLabel = '実行する', danger = false, input = null }) {
  return new Promise((resolve) => {
    const dlg = $('dlg');
    $('dlgTitle').textContent = title; $('dlgBody').textContent = body; $('dlgError').textContent = '';
    // 理由の欄は、ほかの入力（休憩の再開予定の時刻など）にも使う
    $('dlgReasonWrap').style.display = needReason ? 'grid' : 'none'; $('dlgReason').value = input?.value ?? '';
    $('dlgReasonLabel').textContent = input?.label ?? '理由（必須）'; $('dlgReason').type = input?.type ?? 'text';
    $('dlgReason').placeholder = input ? '' : '例: 商品の取り違え';
    $('dlgOk').textContent = okLabel; $('dlgOk').className = danger ? 'btn btn-danger' : 'btn btn-primary';
    const done = (value) => { $('dlgForm').onsubmit = null; $('dlgCancel').onclick = null; dlg.oncancel = null; dlg.close(); resolve(value); };
    $('dlgForm').onsubmit = (ev) => {
      ev.preventDefault();
      const reason = $('dlgReason').value.trim();
      if (needReason && !reason) { $('dlgError').textContent = input ? `${input.label}を入力してください。` : '理由を入力してください。'; $('dlgReason').focus(); return; }
      done({ reason });
    };
    $('dlgCancel').onclick = () => done(null);
    dlg.oncancel = (ev) => { ev.preventDefault(); done(null); };
    dlg.showModal();
    if (needReason) $('dlgReason').focus(); else $('dlgCancel').focus(); // 誤って続けて押しても、実行されないように
  });
}
const CONFIRM = {
  cancel: (l) => ({ title: `No.${l.lotNo} を取りやめますか？`, body: 'この品のすべての入札を無効にして、待機に戻します。入札の記録は残ります。', okLabel: '取りやめる', danger: true }),
  // 締め: 取り消せないので、押した結果（落札か流札か）を書いて確かめる。オークショニアの画面と同じ（発注者の決定。報告書 80 章）
  close: (l) => {
    const willSell = l.currentPrice !== null && !!l.urikiri; // ランプはサーバーが決める（報告書 89 章）
    return { title: '締めますか？', body: willSell ? `No.${l.lotNo}　${l.highestPaddle}番 ${yen(l.currentPrice)} で落札になります。` : `No.${l.lotNo}　流札になります。`, okLabel: '締める' };
  },
  urikiri: (l) => ({ title: 'うりきりにしますか？', body: l.reservePrice === null ? `No.${l.lotNo}　うりきりのランプを点けます。締めると、最高入札者に落札します。` : `No.${l.lotNo}　最低落札額 ${yen(l.reservePrice)} に届かなくても、締めると、最高入札者に落札します。`, okLabel: 'うりきりにする' }),
  exclude: (l) => ({ title: `No.${l.lotNo} を除外しますか？`, body: 'この品は「未実施」になり、この開催では競りにかけられなくなります。', okLabel: '除外する', danger: true }),
};
async function lotCmd(action, lotId, needReason = false) {
  let reason = '';
  if (needReason) {
    const ans = await ask({ ...CONFIRM[action](S.lots.get(lotId)), needReason: true });
    if (!ans) return;
    reason = ans.reason;
  } else if ((action === 'close' || action === 'urikiri') && !(await ask(CONFIRM[action](S.lots.get(lotId))))) return;
  return cmd(action, { lotId, reason });
}
document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
  const lot = focusLot(); if (!lot) return;
  b.disabled = true; // 二度押しを防ぐ（結果が届いたら元に戻す）
  await lotCmd(b.dataset.act, lot.id, !!b.dataset.reason);
  b.disabled = false; render();
}));
// 配信の停止は、オンラインの全員の映像が止まるので、確かめる（報告書 81 章）
document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', async () => {
  if (b.dataset.cmd === 'stream_stop' && !(await ask({ title: '配信を停止しますか？', body: 'オンラインで参加している全員の映像が止まります。「配信を開始」で再開できます。', okLabel: '停止する', danger: true }))) return;
  cmd(b.dataset.cmd);
}));
document.querySelectorAll('[data-crash]').forEach((b) => b.addEventListener('click', async () => {
  const ans = await ask({ title: 'サーバーを強制終了しますか？', body: `${b.textContent.replace('…', '')}。参加者の画面は「再接続中」になり、受付中の品は復旧の規則に従って中断または確定になります。`, okLabel: '強制終了する', danger: true });
  if (ans) cmd('crash', { point: b.dataset.crash });
}));
document.querySelectorAll('[data-mark]').forEach((b) => b.addEventListener('click', () => cmd('mark', { label: $('markLabel').value || 'unnamed', phase: b.dataset.mark })));
$('markForm').addEventListener('submit', (ev) => ev.preventDefault());
// 品を追加: 通ってから欄を空にする（断られたら、入れた内容を残して、理由をフォームのすぐ下に出す。報告書 81 章）
$('addLot').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if ($('create').disabled) return;
  $('create').disabled = true; $('create').textContent = '追加しています…';
  const res = await cmd('create_lot', { title: $('newTitle').value, startPrice: $('newPrice').value === '' ? null : Number($('newPrice').value), reservePrice: $('newReserve').value === '' ? null : Number($('newReserve').value) }, 'addMsg');
  $('create').textContent = '品を追加'; renderEvent();
  if (res?.ok) { for (const id of ['newTitle', 'newPrice', 'newReserve']) $(id).value = ''; $('newTitle').focus(); }
  else $(res?.message?.includes('最低落札額') ? 'newReserve' : res?.message?.includes('開始') ? 'newPrice' : 'newTitle').focus();
});

function onMessage(msg, at) {
  switch (msg.type) {
    case 'welcome': case 'snapshot':
      S.lots = new Map(msg.lots.map((l) => [l.id, l])); S.focus = msg.focusLotId; S.history = msg.history; S.stream = msg.stream;
      S.comments = msg.comments ?? S.comments; renderComments();
      // 開催が切り替わっていたら（前の開催の画面を開いたままだった）、読み込み直して、最初からにする
      if (reloadOnNewEvent(S, msg)) return;
      S.connected = true; S.ended = !msg.event && !!msg.ended;
      S.event = msg.event ?? null; if (msg.sold) S.sold = msg.sold; renderEvent(); renderSold();
      if (msg.type === 'welcome') {
        log(`接続しました（${msg.name}）`);
        S.playerUrl = msg.playerScriptUrl;
        document.querySelectorAll('[data-crash]').forEach((b) => { b.disabled = !msg.allowCrash; });
        // 障害の模擬は、検証用の環境でだけ出す（本番の進行役の画面には、強制終了のボタンを置かない）
        $('crashBox').hidden = !msg.allowCrash;
        // 検証用の道具（測定・障害の模擬）は、検証用の設定のときだけ出す
        S.dev = !!msg.allowCrash; $('devBox').hidden = !S.dev;
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
      if (msg.lotId === S.focus) S.history.push({ seq: msg.seq, amount: msg.amount, received_at: msg.receivedAt, valid: 1, paddle: msg.paddle, proxy: msg.proxy });
      render(); break;
    }
    case 'bid_void': { // 代理入札の取り消し: その入札を無効にして、品を1つ前の状態に戻す
      S.lots.set(msg.lot.id, msg.lot);
      const h = S.history.find((x) => x.seq === msg.seq); if (h) h.valid = 0;
      log(`代理入札を取り消しました（受付連番 ${msg.seq}）`);
      render(); break;
    }
    case 'event': S.event = msg.event; S.ended = !msg.event && !!msg.ended; S.schedule = null; if (msg.ended) log('開催を終了しました'); renderEvent(); render(); break; // render: 開催を始めると、品を開始するボタンが押せるようになる
    case 'sold': S.sold = msg.sold; renderSold(); break;
    case 'result':
      link.send({ type: 'result_ack', lotId: msg.lotId, at: at + link.offset, net: 'console' });
      S.lots.set(msg.lotId, msg.lot); render(); break;
    case 'stream': {
      const p = S.stream; S.stream = msg.stream;
      if (p && p.live !== msg.stream.live) log(`配信: ${msg.stream.live ? '映像が届きはじめました' : '映像が止まりました'}`);
      if (p && p.obsActive !== msg.stream.obsActive) log(`OBS: ${msg.stream.obsActive ? '配信開始' : '配信停止'}`);
      if (p && p.agentConnected !== msg.stream.agentConnected) log(`配信エージェント: ${msg.stream.agentConnected ? '接続' : '切断'}`);
      renderStream(); break;
    }
    case 'comment': S.comments.push(msg); if (S.comments.length > 30) S.comments.shift(); renderComments(); break;
    case 'comment_hidden': S.comments = S.comments.filter((c) => c.id !== msg.id); renderComments(); break;
    case 'presence': $('presence').textContent = msg.members; $('presenceSplit').textContent = `（会場 ${msg.venue}・オンライン ${msg.online}）`; break;
    case 'error': log('エラー: ' + msg.message); break;
  }
}
// ---- 開催（休憩・開催終了）と、落札一覧、代理入札
const PAYMENT = { transfer: '銀行振込', cash: '当日現金' };
const RECEIVE = { pickup: '現地受け取り', ship: '配送' };
// 競りの時間外: 本日の開催がない、または終わったうえで、進行中・待機の品がないとき。進行の操作は出さない（発注者の指示）
const WORKING = ['waiting', 'preparing', 'preparing_warn', 'open', 'suspended'];
const offHours = () => !token && S.connected && (S.ended || !S.event) && ![...S.lots.values()].some((l) => WORKING.includes(l.status));
async function renderOffHours() {
  const off = offHours();
  $('offhours').hidden = !off; $('consoleMain').hidden = off;
  if (!off) return;
  $('offTitle').textContent = S.ended ? '本日の競りは終了しました' : '本日の競りはありません';
  if (!S.schedule) S.schedule = await fetch('/api/schedule', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => null);
  const today = S.schedule?.today ?? '';
  const next = (S.schedule?.events ?? []).find((e) => e.startsAt.slice(0, 10) > today);
  $('offNext').hidden = !next;
  if (!next) return;
  const [y, m, dd] = next.startsAt.slice(0, 10).split('-').map(Number);
  $('offDate').textContent = `${m}月${dd}日（${'日月火水木金土'[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]}）`;
  $('offInfo').textContent = `${next.title}　${next.startsAt.slice(11, 16)}〜　${next.venueName}`;
}
function renderEvent() {
  renderOffHours();
  const e = S.event;
  // 本日の公開中の開催がないと、追加した品は、どの開催にも入らず、会員から見えない。知らせて、追加を止める（検証用の合言葉で入ったときは止めない）
  $('noEvent').hidden = !!e || !!token;
  $('create').disabled = !e && !token;
  $('eventBar').hidden = !e;
  $('proxySection').hidden = !e; // 代理入札は、開催の参加者（会場参加）が相手なので、開催があるときだけ
  if (!e) return;
  $('evTitle').textContent = e.title;
  $('evPhase').textContent = e.phase === 'break' ? `休憩中（再開予定 ${e.resumeAt}）` : e.phase === 'running' ? '進行中' : `開始前（予定 ${e.startsAt}〜）`;
  // 始める前は「開催を始める」だけ。休憩・終了は、始めてから
  $('b_evstart').hidden = !!e.phase; $('b_break').hidden = !e.phase; $('b_end').hidden = !e.phase && !e.stale;
  $('evPhase').dataset.on = e.phase === 'running' ? '1' : '0';
}
// 終了の予定時刻を過ぎても終了していなければ、注意を出す（自動では終了しない。FR-EVT-003）
setInterval(() => {
  if (!S.event || !link) return;
  const now = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false }).format(link.serverNow());
  const warn = now >= S.event.endsAt ? `終了の予定（${S.event.endsAt}）を過ぎています` : '';
  if ($('evWarn').textContent !== warn) $('evWarn').textContent = warn;
}, 5000);
function renderSold() {
  const cell = (text, cls) => { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; return td; };
  $('sold').replaceChildren(...S.sold.map((x) => {
    const tr = document.createElement('tr');
    tr.append(cell(x.lotNo, 'num'), cell(x.title, 'dyn'), cell(`${x.paddle}番${x.proxy ? '（代理）' : ''}`, 'num'), cell(yen(x.amount), 'digits amt'), cell(RECEIVE[x.receive] ?? ''), cell(PAYMENT[x.payment] ?? ''));
    return tr;
  }));
  $('soldCount').textContent = `${S.sold.length}件`;
}
$('b_evstart').addEventListener('click', async () => {
  const ans = await ask({ title: '開催を始めますか？', body: 'ここから、品を開始できるようになります。経過時間は、ここから数えます。', okLabel: '開催を始める' });
  if (ans) cmd('event_start');
});
$('b_break').addEventListener('click', async () => {
  const ans = await ask({ title: '休憩に入りますか？', body: '参加者の画面と会場モニターに、再開の予定を出します。', okLabel: '休憩に入る', needReason: true, input: { label: '次の開始予定', type: 'time' } });
  if (ans) cmd('event_break', { resumeAt: ans.reason });
});
$('b_end').addEventListener('click', async () => {
  const waiting = [...S.lots.values()].filter((l) => l.status === 'waiting').length;
  const ans = await ask({ title: '開催を終了しますか？', body: `取り消せません。待機中の品（${waiting}件）は「未実施」になり、配信を停止します。`, okLabel: '開催を終了する', danger: true });
  if (!ans) return;
  const res = await cmd('event_end');
  if (res?.ok) { S.sold = res.sold; renderSold(); }
});
$('proxyBox').addEventListener('toggle', () => {
  const lot = S.lots.get(S.focus);
  if ($('proxyBox').open && lot && !$('pxAmount').value) $('pxAmount').value = lot.minBid; // 既定は、最低入札額
});
$('proxyForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const res = await cmd('proxy_bid', { lotId: S.focus, paddle: Number($('pxPaddle').value), amount: Number($('pxAmount').value), reason: $('pxReason').value || $('pxNote').value, cardChecked: $('pxCard').checked }, 'pxMsg');
  if (res?.ok) { $('pxPaddle').value = ''; $('pxAmount').value = ''; $('pxNote').value = ''; $('pxCard').checked = false; }
  else if (res?.minBid) $('pxAmount').value = res.minBid;
});

let link = null;
const token = takeToken('auction-staff');
const onStatus = (up, why, _r, code) => showOverlay(up, why, code, 'console');
// 検証用の合言葉つきの URL で開いたときは、そのまま入る。なければ、スタッフのログイン（主催者管理者・進行役）で入る
if (token) link = new Link({ token, label: 'console', onMessage, onStatus });
else fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json()).then((me) => {
  if (!me.staff) return location.replace('/staff.html?next=console');
  if (me.staff.role !== 'admin' && me.staff.role !== 'auctioneer') { showOverlay(false, '競りの進行は、主催者管理者と進行役だけができます', 'FORBIDDEN', 'console'); return; }
  link = new Link({ token: null, as: 'console', label: 'console', onMessage, onStatus });
}).catch(() => { $('overlay').style.display = 'flex'; $('overlayText').textContent = 'サーバーにつながりません'; });
