// データベースの形の変更を、番号を付けて、1回ずつ行う（報告書 119 章）。
// これまでは「無ければ作る」「列が無ければ足す」を、起動のたびに確かめていた。足すだけなら足りるが、
// 中身の移し替え・作り直しは、済んだかどうかを覚えていないと、安全に書けない。
// 決まり: 一度配った手順は、書き換えない（直すときは、新しい番号を足す）。番号は、範囲（scope）ごとに 1 から続ける。

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} scope 手順の持ち主（'api'・'billing' など）
 * @param {{ v: number, name: string, up: (db: import('better-sqlite3').Database) => void }[]} steps
 * @param {{ nowMs?: () => number, log?: (text: string) => void }} [opts]
 * @returns {{ applied: number[], version: number }}
 */
export function migrate(db, scope, steps, { nowMs = () => Date.now(), log = console.log } = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (scope TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, at REAL NOT NULL, PRIMARY KEY (scope, version))');
  steps.forEach((s, i) => { if (s.v !== i + 1) throw new Error(`移行の手順の番号が、続いていません（${scope}: ${i + 1} 番目が ${s.v}）`); });
  const done = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations WHERE scope = ?').get(scope).v;
  // 前の版に戻したとき（データベースのほうが新しい）: 止めない。知らせるだけ（戻しの手順を、ふさがないため）
  if (done > steps.length) log(`【注意】データベースの形（${scope}: ${done}）が、このプログラムの知っている番号（${steps.length}）より新しいです`);
  const applied = [];
  for (const s of steps.slice(done)) {
    // 1つの手順は、全部できるか、何もしないか（途中で止まっても、半分だけ済んだ形を残さない）
    db.transaction(() => {
      s.up(db);
      db.prepare('INSERT INTO schema_migrations (scope, version, name, at) VALUES (?, ?, ?, ?)').run(scope, s.v, s.name, nowMs());
    })();
    applied.push(s.v);
  }
  return { applied, version: Math.max(done, steps.length) };
}
