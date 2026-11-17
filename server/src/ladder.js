// 価格の段（本仕様 FR-BID-003、FR-BID-005）
// 価格の段: 開始価格から始め、ある段の金額に、その金額の価格帯の入札単位を足して次の段とする。

/** その金額の価格帯の入札単位を返す。unitOverride があれば、すべての価格帯でその単位を使う。 */
export function unitFor(amount, table, unitOverride = null) {
  if (unitOverride) return unitOverride;
  for (const band of table) {
    if (band.lt === undefined || band.lt === null || amount < band.lt) return band.unit;
  }
  throw new Error('入札単位の表に、最後の帯（lt なし）がありません');
}

/** ある段の次の段 */
export function nextStep(amount, table, unitOverride = null) {
  return amount + unitFor(amount, table, unitOverride);
}

/** 最低入札額: 入札がまだなければ開始価格。入札があれば、現在価格の次の段。 */
export function minimumBid(startPrice, currentPrice, table, unitOverride = null) {
  return currentPrice === null || currentPrice === undefined
    ? startPrice
    : nextStep(currentPrice, table, unitOverride);
}

/**
 * 入札できる最も低い額（発注者の決定: 開始価格以上なら、1円単位で入札できる）。
 * 入札がまだなければ開始価格。入札があれば、現在価格より1円高い額。
 * 価格の段（minimumBid）は、入札の欄に最初に入れておく「次の入札額」の目安としてだけ使う。
 */
export function minimumAllowed(startPrice, currentPrice) {
  return currentPrice === null || currentPrice === undefined ? startPrice : currentPrice + 1;
}

/**
 * 金額が「価格の段」に乗っているか。
 * from（段に乗っていると分かっている金額）から段を進めて確かめる。
 * 受理された現在価格は必ず段に乗っているので、通常は from=最低入札額 から数段で終わる。
 */
export function isOnLadder(amount, startPrice, table, unitOverride = null, from = startPrice) {
  if (!Number.isSafeInteger(amount) || amount < startPrice) return false;
  let step = amount >= from ? from : startPrice;
  // 上限つきで進める（1段は必ず1円以上増えるので必ず終わるが、巨大な金額での長いループを避ける）
  for (let i = 0; step < amount && i < 1_000_000; i++) step = nextStep(step, table, unitOverride);
  return step === amount;
}

export function validateTable(table) {
  if (!Array.isArray(table) || table.length === 0) throw new Error('入札単位の表が空です');
  let prev = -Infinity;
  table.forEach((b, i) => {
    if (!Number.isSafeInteger(b.unit) || b.unit <= 0) throw new Error('入札単位は正の整数にしてください');
    const last = i === table.length - 1;
    if (last ? b.lt != null : !(Number.isSafeInteger(b.lt) && b.lt > prev)) {
      throw new Error('入札単位の表は lt の昇順にし、最後の帯だけ lt を省いてください');
    }
    prev = b.lt ?? prev;
  });
}
