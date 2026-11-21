// 利用会社への手数料の集計（FR-FEE）（報告書 119 章で、billing.js から分けた。中身は、分ける前と同じ）
import { FEE_RATE, PAY, addDays } from './shared.js';

export function createFees(deps) {
  const { HttpError, audit, bad, db, jst, needStaff, nowMs, route, setting, staffLineView, today } = deps;
  // ------------------------------------------------------------ 手数料の集計（FR-FEE-001〜010）
  const ceilFee = (amount) => Math.ceil(amount * FEE_RATE / 100);
  // その月の、手数料（差し引く前）と、差し引き
  function feeRaw(month, all) {
    const monthOf = (ms) => jst(ms).slice(0, 7);
    const base = all.filter((c) => monthOf(c.cleared_at) === month && !(c.reversed_at && monthOf(c.reversed_at) === month)).reduce((s, c) => s + c.amount, 0);
    const reversed = all.filter((c) => c.reversed_at && monthOf(c.reversed_at) === month && monthOf(c.cleared_at) < month);
    const refunded = db.prepare(`SELECT r.*, l.amount AS line_amount, l.premium FROM refunds r JOIN bill_lines l ON l.id = r.line_id
      WHERE substr(r.refunded_on, 1, 7) = ? AND l.kind IN ('lot','promote') AND EXISTS (SELECT 1 FROM clearings c WHERE c.line_id = l.id AND c.reversed_at IS NULL)`).all(month)
      .map((r) => Math.min(r.line_amount, Math.round(r.amount * r.line_amount / (r.line_amount + (r.premium ?? 0)))));
    return { gross: Math.floor(base * FEE_RATE / 100), deduction: reversed.reduce((s, c) => s + ceilFee(c.amount), 0) + refunded.reduce((s, h) => s + ceilFee(h), 0) };
  }
  // 前の月までの、差し引ききれなかった分（いちばん古い月から、順に計算する）
  function feeCarry(month, all) {
    const monthOf = (ms) => jst(ms).slice(0, 7);
    const firsts = [all[0] ? monthOf(all[0].cleared_at) : null, db.prepare('SELECT MIN(substr(refunded_on, 1, 7)) AS m FROM refunds').get().m].filter(Boolean).sort();
    if (!firsts.length || firsts[0] >= month) return 0;
    let carry = 0;
    for (let m = firsts[0]; m < month; m = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)).toISOString().slice(0, 7)) {
      const r = feeRaw(m, all);
      carry = Math.max(0, r.deduction + carry - r.gross);
    }
    return carry;
  }
  function feeSummary(month) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw bad('月を、2026-12 の形で指定してください');
    const monthOf = (ms) => jst(ms).slice(0, 7);
    const all = db.prepare("SELECT c.*, l.label, l.kind, l.event_id FROM clearings c JOIN bill_lines l ON l.id = c.line_id WHERE l.kind IN ('lot','promote') ORDER BY c.cleared_at").all();
    // 対象: その月に消し込んだ明細（月の区切りは、消し込みの日。日本時間）。同じ月のうちに取り消したものは、数えない
    const counted = all.filter((c) => monthOf(c.cleared_at) === month && !(c.reversed_at && monthOf(c.reversed_at) === month));
    const base = counted.reduce((s, c) => s + c.amount, 0);
    // 差し引き: 前の月までに数えた消し込みを、この月に取り消したもの。この月に返金した明細。1件ごとに切り上げる
    const reversed = all.filter((c) => c.reversed_at && monthOf(c.reversed_at) === month && monthOf(c.cleared_at) < month);
    // 返金の差し引きは、手数料の対象として数えた（消し込みが取り消されていない）明細の分だけ。差し引く額は、返金額のうち落札額にあたる分の 5%
    // （これまでは、返金1件ごとに落札額全体の 5% を引いていた。本番運用の評価 B1。報告書 104 章）
    const refunded = db.prepare(`SELECT r.*, l.label, l.amount AS line_amount, l.premium FROM refunds r JOIN bill_lines l ON l.id = r.line_id
      WHERE substr(r.refunded_on, 1, 7) = ? AND l.kind IN ('lot','promote') AND EXISTS (SELECT 1 FROM clearings c WHERE c.line_id = l.id AND c.reversed_at IS NULL)`).all(month)
      .map((r) => ({ ...r, hammer: Math.min(r.line_amount, Math.round(r.amount * r.line_amount / (r.line_amount + (r.premium ?? 0)))) }));
    const deduction = reversed.reduce((s, c) => s + ceilFee(c.amount), 0) + refunded.reduce((s, r) => s + ceilFee(r.hammer), 0);
    // 手数料 = 落札額の合計 × 5%（1円未満は切り捨て。合計に対して1回だけ丸める）。買歩銭は、対象に含めていない【前提】
    // 差し引きが、その月の手数料より多いときは、多い分を、次の月へ繰り越す（消えないように）
    const carriedIn = feeCarry(month, all);
    const gross = Math.floor(base * FEE_RATE / 100);
    const fee = Math.max(0, gross - deduction - carriedIn);
    const carriedOut = Math.max(0, deduction + carriedIn - gross);
    const minimum = Number(setting('fee_minimum')) || 0;         // 最低保証額（未決。OQ-19）
    const charge = Math.max(fee, minimum);
    const taxMode = setting('fee_tax_mode') === 'inclusive' ? 'inclusive' : 'exclusive'; // 外税 / 内税（FR-FEE-009）
    const tax = taxMode === 'exclusive' ? Math.floor(charge * 10 / 100) : 0;
    const confirm = db.prepare('SELECT * FROM fee_confirms WHERE month = ?').get(month);
    return {
      month, base, rate: FEE_RATE, deduction, carriedIn, carriedOut, fee, minimum, charge, taxMode, tax, total: charge + tax,
      confirmedOn: confirm ? jst(confirm.confirmed_at) : null,
      // 根拠になる明細ごとの一覧（FR-FEE-006）
      details: [
        ...counted.map((c) => ({ label: c.label, amount: c.amount, method: PAY[c.method], clearedOn: jst(c.cleared_at), note: '' })),
        ...reversed.map((c) => ({ label: c.label, amount: -c.amount, method: PAY[c.method], clearedOn: jst(c.cleared_at), note: `消し込みの取り消し（${jst(c.reversed_at)}）` })),
        ...refunded.map((r) => ({ label: r.label, amount: -r.hammer, method: PAY[r.method], clearedOn: '', note: `返金 ${r.amount.toLocaleString('ja-JP')}円のうち落札額の分（${r.refunded_on}）` })),
      ],
    };
  }
  route('GET', '/api/billing/fees', (ctx) => {
    needStaff(ctx, 'admin', 'operator'); // 手数料の集計と明細は、開発・運営者も見られる（8.14）
    return feeSummary(ctx.url.searchParams.get('month') ?? today().slice(0, 7));
  });
  route('POST', '/api/billing/fees/confirm', (ctx, body) => {
    const me = needStaff(ctx, 'admin');
    const s = feeSummary(String(body.month ?? ''));
    if (s.month >= today().slice(0, 7)) throw new HttpError(409, '確認済みにできるのは、締めた月（先月まで）の明細です');
    db.prepare('INSERT OR IGNORE INTO fee_confirms (month, confirmed_at, staff_id) VALUES (?,?,?)').run(s.month, nowMs(), me.id);
    audit(ctx, 'fee.confirm', { target: `month:${s.month}`, after: { total: s.total } });
    return { ok: true };
  });
  // 長く未払いのままの明細: 支払期限の翌日から30日以上、消し込みも解除もされていない（FR-FEE-007）
  route('GET', '/api/billing/long-unpaid', (ctx) => {
    needStaff(ctx, 'admin', 'operator');
    const limit = addDays(today(), -30);
    const rows = db.prepare(`SELECT l.* FROM bill_lines l JOIN invoices i ON i.id = l.invoice_id
      WHERE l.cleared_at IS NULL AND l.cancelled_at IS NULL AND i.sent_at IS NOT NULL AND i.due_date IS NOT NULL AND i.due_date <= ? AND l.kind IN ('lot','promote') ORDER BY i.due_date`).all(limit);
    return { lines: rows.map(staffLineView) };
  });
  return { feeSummary };
}
