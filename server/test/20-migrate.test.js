// データベースの形の変更（番号つきの移行）。報告書 119 章
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/migrate.js';

const quiet = { log: () => {} };

test('移行: 番号の順に、1回ずつ行う。2度目は何もしない。あとから足した手順だけを行う', () => {
  const db = new Database(':memory:');
  const s1 = { v: 1, name: '表を作る', up: (d) => d.exec('CREATE TABLE t (a INTEGER)') };
  const s2 = { v: 2, name: '列を足す', up: (d) => d.exec('ALTER TABLE t ADD COLUMN b TEXT') };
  assert.deepEqual(migrate(db, 'x', [s1], quiet), { applied: [1], version: 1 });
  assert.deepEqual(migrate(db, 'x', [s1], quiet), { applied: [], version: 1 }, '2度目は、何もしない（CREATE TABLE が2回走れば、エラーになる）');
  assert.deepEqual(migrate(db, 'x', [s1, s2], quiet), { applied: [2], version: 2 });
  assert.deepEqual(db.prepare('PRAGMA table_info(t)').all().map((c) => c.name), ['a', 'b']);
  // 範囲が別なら、番号は別に数える
  assert.deepEqual(migrate(db, 'y', [{ v: 1, name: '別の表', up: (d) => d.exec('CREATE TABLE u (a INTEGER)') }], quiet).applied, [1]);
});

test('移行: 途中で失敗した手順は、何も残さない。直したあと、同じ番号からやり直せる', () => {
  const db = new Database(':memory:');
  const bad = { v: 1, name: '途中で失敗', up: (d) => { d.exec('CREATE TABLE t (a INTEGER)'); d.exec('INSERT INTO t VALUES (1)'); throw new Error('失敗'); } };
  assert.throws(() => migrate(db, 'x', [bad], quiet), /失敗/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 't'").get().n, 0, '半分だけ済んだ形を、残さない');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 0);
  assert.deepEqual(migrate(db, 'x', [{ v: 1, name: '直した', up: (d) => d.exec('CREATE TABLE t (a INTEGER)') }], quiet).applied, [1]);
});

test('移行: 番号が飛んでいたら、始める前に断る。データベースのほうが新しいとき（前の版に戻したとき）は、止めずに知らせる', () => {
  const db = new Database(':memory:');
  assert.throws(() => migrate(db, 'x', [{ v: 2, name: '飛んでいる', up: () => {} }], quiet), /続いていません/);
  const steps = [1, 2].map((v) => ({ v, name: `手順${v}`, up: () => {} }));
  migrate(db, 'x', steps, quiet);
  const said = [];
  assert.deepEqual(migrate(db, 'x', steps.slice(0, 1), { log: (t) => said.push(t) }), { applied: [], version: 2 });
  assert.match(said[0], /新しい/);
});
