// 会場の大型モニター: 現在価格・最高入札者の参加番号・入札の履歴を、大きく出す（見るだけ。操作はできない）。
// 金額は、全員に同じものを、そのまま出す。
'use strict';

const $ = (id) => document.getElementById(id);
const S = { lots: new Map(), focus: null, history: [], event: null, ended: false };

function render() {
  const lot = S.lots.get(S.focus);
  // 待機（品がない）・休憩・終了は、中央の大きな知らせにする。次の品が決まっていれば、予告する
  const next = [...S.lots.values()].find((l) => l.status === 'waiting');
  const idle = S.ended ? ['本日の競りは終了しました', 'ご参加ありがとうございました']
    : S.event?.phase === 'break' ? ['休憩中', `再開の予定 ${S.event.resumeAt}${next ? `　次は No.${next.lotNo} ${next.title}` : ''}`]
    : !lot ? ['次の品をお待ちください', next ? `次は No.${next.lotNo} ${next.title}` : '']
    : null;
  $('idle').hidden = !idle;
  $('now').hidden = !!idle;
  document.querySelector('.hist').hidden = !!idle || S.history.length === 0;
  if (idle) { $('idleTitle').textContent = idle[0]; $('idleSub').textContent = idle[1]; }
  // いま入札できるか（受付中・中断など）を、色の付いた札で出す
  $('state').textContent = lot ? STATE_LABEL[lot.status] ?? '' : '';
  $('state').dataset.st = lot?.status ?? '';
  $('lotNo').textContent = lot ? `No.${lot.lotNo}` : '';
  $('title').textContent = lot ? lot.title : '次の品をお待ちください';
  const closed = lot && (lot.status === 'sold' || lot.status === 'unsold');
  $('priceLabel').textContent = !lot ? '' : lot.status === 'sold' ? '落札額' : lot.currentPrice === null ? '開始価格' : '現在価格';
  $('price').textContent = lot ? yen(lot.currentPrice ?? lot.startPrice) : '';
  $('who').className = lot?.status === 'sold' ? 'who sold' : 'who';
  $('who').textContent = !lot ? '' : lot.status === 'sold' ? `${lot.highestPaddle}番 落札`
    : lot.status === 'unsold' ? '流札' : lot.highestPaddle ? `最高入札者 ${lot.highestPaddle}番` : closed ? '' : STATE_LABEL[lot.status] ?? '';
  // 新しい入札を上に、8件まで
  $('history').replaceChildren(...S.history.slice(-8).reverse().map((h) => {
    const li = document.createElement('li');
    if (!h.valid) li.className = 'void';
    const who = document.createElement('span'); who.textContent = `${h.paddle}番${h.proxy ? '（代理）' : ''}`;
    const amt = document.createElement('span'); amt.className = 'digits'; amt.textContent = yen(h.amount);
    li.append(who, amt);
    return li;
  }));
}
function showEvent(event, ended = false) {
  S.event = event; S.ended = ended;
  // 休憩・終了の知らせは、画面の中央に大きく出すので、右上は開催の名前だけ
  $('event').textContent = !event ? '' : event.title;
}
function onMessage(msg) {
  switch (msg.type) {
    case 'welcome': case 'snapshot':
      S.lots = new Map(msg.lots.map((l) => [l.id, l])); S.focus = msg.focusLotId; S.history = msg.history; showEvent(msg.event ?? null, !msg.event && !!msg.ended); render(); break;
    case 'lot': {
      const prev = S.lots.get(msg.lot.id);
      S.lots.set(msg.lot.id, msg.lot);
      if (msg.lot.status !== 'waiting' && msg.lot.status !== 'not_held' && S.focus !== msg.lot.id) { S.focus = msg.lot.id; S.history = []; }
      if (prev && prev.status === 'suspended' && msg.lot.status === 'waiting') S.history.forEach((h) => { h.valid = 0; });
      break;
    }
    case 'price': {
      const lot = S.lots.get(msg.lotId);
      if (lot) Object.assign(lot, { currentPrice: msg.currentPrice, minBid: msg.minBid, highestPaddle: msg.paddle });
      if (msg.lotId === S.focus) S.history.push({ seq: msg.seq, amount: msg.amount, valid: 1, paddle: msg.paddle, proxy: msg.proxy });
      break;
    }
    case 'bid_void': { S.lots.set(msg.lot.id, msg.lot); const h = S.history.find((x) => x.seq === msg.seq); if (h) h.valid = 0; break; }
    case 'result': S.lots.set(msg.lotId, msg.lot); break;
    case 'event': showEvent(msg.event, msg.ended); break;
    default: return;
  }
  render();
}
fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json()).then((me) => {
  if (!me.staff) return location.replace('/staff.html?next=monitor');
  new Link({ token: null, as: 'monitor', label: 'monitor', onMessage, onStatus: (up, why, _r, code) => showOverlay(up, why, code, 'monitor') });
}).catch(() => { $('overlayText').textContent = 'サーバーにつながりません'; });
