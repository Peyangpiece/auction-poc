// 管理画面: 受付（来場確認・会場の QR コード）（報告書 122 章で、staff.js から分けた。読み込む順番は staff.html のとおり。名前は、ファイルをまたいで共有する）
'use strict';

// ------------------------------------------------------------ 受付: 来場確認（FR-MODE-002・004）と、会場の QR コード
const PAY = { transfer: '銀行振込', cash: '当日現金' };
const RECV = { pickup: '現地受け取り', ship: '配送' };
async function receptionPanel() {
  const res = await api('GET', '/api/reception');
  if (!res.ok) return [el('p', { class: 'msg', text: res.message })];
  // 開催がない日: 次にすることへの道を出す（開催を作れるのは主催者管理者だけ。報告書 82 章）
  if (!res.event) return [el('div', { class: 'empty' }, el('p', { text: '本日の開催はありません。' }),
    me.role === 'admin' && smallBtn('開催を開く', () => leavePanel(() => { pendingNotice = null; show('events'); })))];
  const waiting = res.participants.filter((p) => p.mode === 'venue' && !p.checkedIn).length;
  // 受付でやることがある人（来場の確認待ち）を上に。「参加」と「来場」の列は、1つの「状態」にまとめた（報告書 90 章）
  const order = (p) => (p.mode === 'venue' && !p.checkedIn ? 0 : p.mode === 'venue' ? 1 : 2);
  const sorted = [...res.participants].sort((a, b) => order(a) - order(b) || a.paddle - b.paddle);
  const rows = sorted.map((p) => el('tr', {},
    el('td', { class: 'n paddle', text: String(p.paddle) }),
    el('td', { class: 'dyn', text: p.name }),
    el('td', {}, p.mode === 'venue'
      ? el('span', { class: 'state', 'data-on': p.checkedIn ? '1' : '0', text: p.checkedIn ? '来場確認済み' : '確認待ち' })
      : el('span', { class: 'state state--quiet', text: 'オンライン' })),
    el('td', { class: 'note', text: `${RECV[p.receive]}・${PAY[p.payment]}` }),
    act(
      p.mode === 'venue' && !p.checkedIn && smallBtn('来場を確認', async () => { const r = await api('POST', `/api/reception/${p.id}/checkin`); if (!r.ok) alertLine(r.message); show('reception'); }, 'btn-primary'),
      p.mode === 'online' && smallBtn('会場参加にする', () => switchDialog(p)))));
  return [
    el('div', { class: 'toolbar' },
      el('p', { class: 'dyn', text: `${res.event.title}　確認待ち ${waiting} 人` }),
      el('div', { class: 'toolbar__acts' },
        smallBtn('参加手続きを代わりに行う', () => askForm('参加手続きを、代わりに行う', '',
          [field('会員の電話番号', 'phone', { type: 'tel', inputMode: 'tel', required: true }),
            field('受け取り方法', 'receive', { options: [['', '選んでください'], ['pickup', '現地受け取り'], ['ship', '配送']] }),
            field('支払方法', 'payment', { options: [['', '選んでください'], ['cash', '当日現金'], ['transfer', '銀行振込']] })],
          async (d) => { const r = await api('POST', '/api/reception/join', d); if (r.ok) alertLine(`参加番号 ${r.paddle} を振りました。この番号の札を渡してください。`); return r; }, '参加番号を振る')), ' ',
        smallBtn('会場の QR コード', () => qrDialog(res.event)), ' ',
        smallBtn('QR コードを読み取る', scanDialog, 'btn-primary'))),
    el('p', { class: 'msg', id: 'line', role: 'alert' }),
    (() => { const t = table(['参加番号', '名前', '状態', '受け取り・支払', ''], rows, '参加手続きを済ませた人は、まだいません。'); t.classList.add('reclist'); return t; })(),
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
// 来場確認の QR コードを、受付のスマホのカメラで読み取る（報告書 91 章）。
// 読み取ったら名前と参加番号を出し、受付係が本人と見比べてから「来場を確認」を押す。終わると、そのまま次の人を読み取る
let jsQRLoad = null;
const loadJsQR = () => (jsQRLoad ??= new Promise((resolve, reject) => {
  const s = el('script', { src: '/jsqr.js' });
  s.onload = () => resolve(window.jsQR);
  s.onerror = () => { jsQRLoad = null; reject(new Error('load')); };
  document.head.append(s);
}));
async function scanDialog() {
  const video = el('video', { class: 'scanvideo', playsInline: true, muted: true, 'aria-hidden': 'true' });
  const say = el('p', { class: 'scanhint', role: 'status', text: 'カメラを準備しています…' });
  const result = el('div', { class: 'scanresult', 'aria-live': 'polite' });
  const canvas = document.createElement('canvas');
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
  let stream = null, timer = 0, busy = false, done = 0, last = { code: '', at: 0 };
  const stop = () => { clearTimeout(timer); timer = 0; stream?.getTracks().forEach((t) => t.stop()); stream = null; };
  openDialog('QR コードを読み取る', say, el('div', { class: 'scanbox' }, video), result,
    el('div', { class: 'actions' }, closeBtn()));
  dlg.addEventListener('close', () => { stop(); if (done) show('reception'); }, { once: true });
  const fail = (text) => { stop(); say.textContent = text; video.hidden = true; };
  let jsQR;
  try { jsQR = await loadJsQR(); } catch { return fail('読み取りの準備ができませんでした。通信の状態を確かめて、開き直してください。一覧からも確認できます。'); }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (e) {
    return fail(e?.name === 'NotAllowedError'
      ? 'カメラの使用が許可されていません。ブラウザの設定でこのサイトのカメラを許可してから、もう一度開いてください。一覧からも確認できます。'
      : 'カメラを使えませんでした。ほかのアプリがカメラを使っていないか確かめてください。一覧からも確認できます。');
  }
  if (!dlg.open) return stop(); // 準備の間に閉じられた
  video.srcObject = stream;
  await video.play().catch(() => {});
  say.textContent = '参加者の入札画面の QR コードを、枠の中に入れてください';
  const next = (ms = 150) => { if (stream) timer = setTimeout(tick, ms); };
  const tick = async () => {
    if (!stream || busy || video.readyState < 2) return next();
    const scale = Math.min(1, 640 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);
    const hit = jsQR(ctx2d.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
    // 同じコードが枠に残っていても、続けて何度も読まない
    if (!hit?.data || (hit.data === last.code && Date.now() - last.at < 5000)) return next();
    last = { code: hit.data, at: Date.now() };
    busy = true;
    navigator.vibrate?.(30);
    const r = await api('POST', '/api/reception/scan', { code: hit.data });
    busy = false;
    showHit(r);
    next(400);
  };
  const showHit = (r) => {
    if (!r.ok) { result.replaceChildren(el('p', { class: 'msg', text: r.message })); return; }
    const head = el('p', { class: 'scanwho' }, el('b', { class: 'n', text: `参加番号 ${r.paddle}` }), el('span', { class: 'dyn', text: r.name }));
    if (r.mode !== 'venue') {
      result.replaceChildren(head, el('p', { class: 'msg', text: 'オンライン参加になっています。会場参加にするときは、一覧の「会場参加にする」から切り替えてください。' }));
      return;
    }
    if (r.checkedIn) { result.replaceChildren(head, el('p', { class: 'note', text: '来場確認済みです。' })); return; }
    const msg = msgLine();
    const ok = el('button', { class: 'btn btn-primary', type: 'button', text: '来場を確認', onclick: async () => {
      ok.disabled = true;
      const c = await api('POST', `/api/reception/${r.id}/checkin`);
      if (!c.ok) { ok.disabled = false; msg.textContent = c.message; return; }
      done++;
      result.replaceChildren(head, el('p', { class: 'scandone', text: `来場を確認しました。参加番号 ${r.paddle} の札を渡してください。` }));
    } });
    result.replaceChildren(head, el('p', { class: 'note', text: `${RECV[r.receive]}・${PAY[r.payment]}。本人か確かめてから押してください。` }), ok, msg);
    ok.focus();
  };
  next(0);
}
function qrDialog(event) {
  openDialog('会場の QR コード',
    el('p', { class: 'dyn', text: `${event.title}　会場参加の方は、このコードを読み取ってください。` }),
    el('img', { class: 'qr', src: '/api/reception/qr.svg', alt: '会場参加の QR コード', width: 320, height: 320 }),
    el('div', { class: 'actions' }, smallBtn('印刷', () => window.print()), closeBtn()));
}
