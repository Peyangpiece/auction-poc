// お知らせメールの共通の形（発注者の指示で見直した。報告書 69 章）。
// どのメールも、件名は「【令和の競り】」で始め、本文は「宛名 → 要点 → 次にすること → 署名（主催者の名称と連絡先）」の順にそろえる。
// 文面に、システムに決まりのないこと（発送の時期など）は書かない。

const WEEK = '日月火水木金土';

/** 2026-11-23 → 11月23日（月） */
export function jpDay(date) {
  if (!date) return '';
  const [y, m, d] = String(date).slice(0, 10).split('-').map(Number);
  return `${m}月${d}日（${WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}

/** 署名: 主催者の名称と、設定にある連絡先（住所・電話・メール） */
export function signature(setting) {
  const name = setting('org_name');
  const contact = [setting('org_address') && setting('org_address').replace(/\n/g, ' '), setting('org_tel') && `TEL ${setting('org_tel')}`, setting('org_email')].filter(Boolean);
  return ['――', name ? `${name}（令和の競り）` : '令和の競り', ...contact];
}

/** 本文を組み立てる。name があれば宛名を付ける。lines の null・false は飛ばす */
export function compose(setting, { name = null, lines }) {
  return [...(name ? [`${name} 様`, ''] : []), ...lines.filter((l) => l !== null && l !== false && l !== undefined), '', ...signature(setting)].join('\n');
}

/** 件名: いつも「【令和の競り】」で始める */
export const subjectOf = (text) => `【令和の競り】${text}`;

/** 項目と値の行。項目名を全角の空白でそろえる（[['ご請求額', '¥1,000'], ['お支払い期限', '…']]）。値のない行は飛ばす */
export function kv(rows) {
  const list = rows.filter((r) => r && r[1] !== null && r[1] !== undefined && r[1] !== false && r[1] !== '');
  const w = Math.max(0, ...list.map(([k]) => k.length));
  return list.map(([k, v]) => `${k}${'　'.repeat(w - k.length + 1)}${v}`);
}
