// 運用の警告を、スタッフの画面の上に出す（報告書 118 章）。
// これまでは、保存の失敗や控えの遅れが /healthz に出るだけで、画面を見ている人には分からなかった。
(() => {
  const TEXT = {
    persist_failing: 'データの保存に失敗し続けています。このまま止まると、最近の記録が失われるおそれがあります。開発・運営者に、すぐ連絡してください。',
    journal_degraded: '入札の控えの保存が遅れています。競りは続けられますが、いま止まると、直前の入札が失われるおそれがあります。開発・運営者に連絡してください。',
    journal_not_started: '入札の控えを、まだ始められていません。開発・運営者に連絡してください。',
    journal_replay_off: '「控えをやり直さない」設定（復元のための設定）が、入ったままです。このまま止まると、直前の入札を取り戻せません。開発・運営者に連絡してください。',
    restore_incomplete: '前回の起動のとき、データの一部を元に戻せませんでした。開発・運営者に連絡してください。',
    unreachable: 'サーバーに、つながりません。通信の状態を確かめてください。',
  };
  const box = document.createElement('div');
  box.className = 'opsalert';
  box.setAttribute('role', 'alert');
  box.hidden = true;
  document.body.prepend(box);
  let misses = 0, shown = '';
  const show = (keys) => {
    const text = keys.map((k) => TEXT[k]).filter(Boolean).join('\n');
    if (text === shown) return; // 同じ中身を、読み上げ直さない
    shown = text;
    box.hidden = !text;
    box.textContent = text;
  };
  async function check() {
    try {
      const res = await fetch('/healthz', { cache: 'no-store' });
      const h = await res.json();
      misses = 0;
      show(h.alerts ?? []);
    } catch {
      // 1回の失敗では出さない（配布の切り替えや、一瞬の通信の乱れで、驚かせない）
      if (++misses >= 2) show(['unreachable']);
    }
  }
  check();
  setInterval(check, 30000);
})();
