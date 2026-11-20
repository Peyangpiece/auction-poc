// コードの決まりの確かめ（報告書 119 章）。まちがいを見つける決まりだけを入れる（見た目の好みは、入れない）。
import js from '@eslint/js';
import globals from 'globals';
import fs from 'node:fs';

// 画面のスクリプトが、common.js・site.js・外の再生ライブラリから受け取る名前
const SHARED = 'params yen STATE_LABEL jstShort IVSPlayer setKeepCaret localNow jst takeToken Link showOverlay $ el setupNav api onSubmit telFmt jpDay field personFields markTab tabKeys dateFmt reloadOnNewEvent'.split(' ');

const STAFF_SHARED = Object.fromEntries(fs.readdirSync(new URL('./web/', import.meta.url)).filter((f) => /^staff.*\.js$/.test(f))
  .flatMap((f) => [...fs.readFileSync(new URL('./web/' + f, import.meta.url), 'utf8').matchAll(/^(?:async function|function|const|let) (\w+)/gm)].map((m) => [m[1], 'writable'])));

export default [
  { ignores: ['node_modules/**', 'agent/node_modules/**', 'data/**', 'web/vendor/**', '**/*.min.js', '.wrangler/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-shadow-restricted-names': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unreachable-loop': 'error',
      'no-constant-binary-expression': 'error',
      'require-atomic-updates': 'off',
      'no-irregular-whitespace': ['error', { skipStrings: true, skipComments: true, skipTemplates: true, skipRegExps: true }], // 全角の空白は、文面の中でだけ使う
      'no-control-regex': 'off', // 制御文字を取り除く正規表現を、わざと使っている
    },
  },
  // ブラウザで動くもの（モジュールではない。ファイルをまたいで、同じ名前を共有する）
  { files: ['web/**/*.js'], languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...globals.serviceworker, ...Object.fromEntries(SHARED.map((n) => [n, 'readonly'])) } }, rules: { 'no-unused-vars': ['error', { vars: 'local', args: 'after-used', caughtErrors: 'none' }], 'no-redeclare': ['error', { builtinGlobals: false }] } },
  // 管理画面は、いくつかのファイルに分かれていて、名前を共有する（読み込む順番は staff.html）。共有する名前は、ファイルの先頭の列の宣言から集める
  { files: ['web/staff*.js'], languageOptions: { globals: { ...STAFF_SHARED, api: 'writable' } }, rules: { 'no-redeclare': 'off', 'prefer-const': 'off', 'no-unused-vars': ['error', { vars: 'local', args: 'after-used', caughtErrors: 'none' }] } },
  { files: ['cloudflare/**/*.js'], languageOptions: { globals: { ...globals.serviceworker } } },
  { files: ['tools/e2e/**'], languageOptions: { globals: { ...globals.node, ...globals.browser, axe: 'readonly' } } },
];
