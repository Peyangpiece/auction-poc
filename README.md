# 令和の競り（ライブオークションシステム）

PoC 仕様書 v0.2（引き継ぎ書の第1部）に従って作った、技術検証用の一式です。製品ではありません。

- 今の状況と、検証ごとの結果: [docs/03-PoC報告書.md](docs/03-PoC報告書.md)
- 技術の選定・ディレクトリ構成・作業計画・未決3点: [docs/01-技術選定と作業計画.md](docs/01-技術選定と作業計画.md)
- 実物（Lightsail・OBS・IVS・スマホ）での検証の手順: [docs/02-検証手順.md](docs/02-検証手順.md)
- UX の評価: [docs/04-UX評価.md](docs/04-UX評価.md)
- 運用の手順（バックアップ、開催中に起きたとき）: [docs/05-運用手順.md](docs/05-運用手順.md)

## 構成

```
auction-poc/
├─ server/            入札サーバー（本番に引き継ぐ）
│  ├─ src/
│  │  ├─ index.js     入口。HTTP・WebSocket・認証・障害の模擬
│  │  ├─ auction.js   入札と締めの処理、ロットの状態遷移、起動時の復旧
│  │  ├─ ladder.js    価格の段・最低入札額
│  │  ├─ stream.js    配信の制御（エージェントへの指示、IVS の状態、自動停止）
│  │  ├─ db.js        データベース（SQLite）
│  │  ├─ metrics.js   測定の記録（NDJSON）
│  │  ├─ clock.js / config.js
│  └─ test/           自動テスト（P2-1〜P2-5、状態遷移、配信の制御の仕組み）
├─ agent/             配信エージェント（本番に引き継ぐ。配信用PCに置く）
├─ web/               検証用の画面（入札画面・進行コンソール。本番には引き継がない）
├─ tools/             seed（テスト用アカウント）、load（負荷）、aggregate（集計）、mock-obs、netem
├─ infra/             systemd・Caddy・EventBridge の設定の下書き
└─ docs/
```

## 手元で動かす（AWS も OBS も使わない）

Node.js 22 以上が要ります。

```bash
npm install
```

```bash
(cd agent && npm install)
```

```bash
npm test
```

自動テストは、一時ディレクトリに本物の入札サーバーを別プロセスで立てて、WebSocket でつないで確かめます（P2-1・P2-2 は各1,000回）。

画面を触ってみる場合（OBS と IVS は代役）:

```bash
node tools/seed.js --members 10
```

```bash
POC_IVS_MODE=mock POC_ALLOW_CRASH=1 node server/src/index.js
```

```bash
node tools/mock-obs.js --port 4455
```

```bash
(cd agent && AGENT_SERVER_URL=ws://127.0.0.1:8080/agent AGENT_TOKEN=<data/tokens.json の agent> node src/agent.js)
```

- 進行コンソール: `http://127.0.0.1:8080/console.html?t=<auctioneer のトークン>`
- 入札画面: `http://127.0.0.1:8080/bidder.html?t=<members のトークン>&net=wifi`（`&mode=venue` で会場参加＝映像なし）

トークン（合言葉）は `data/tokens.json` にだけあります。このファイルは共有・コミットしないでください。

## 画面の自動確認

Playwright と Chromium が入っている環境で実行します（このリポジトリの依存には入れていません）。

```bash
npm run test:e2e
```

```bash
npm run test:ux
```

`test:e2e` は、進行コンソールと入札画面を実際に操作する通し確認です。`test:ux` は、端末の幅ごとに横あふれ・押せる範囲・文字の大きさを測ります。

## 負荷と集計

```bash
POC_IVS_MODE=always-live node server/src/index.js
```

```bash
node tools/load.js --clients 100 --lots 30 --label P2-6
```

```bash
node tools/aggregate.js --label P2-6
```

`POC_IVS_MODE=always-live` は、配信なしで競りだけを回すための設定です（P2 用）。

## 主な環境変数（入札サーバー）

| 変数 | 既定 | 意味 |
|---|---|---|
| `PORT` / `HOST` | 8080 / 0.0.0.0 | 待ち受け |
| `POC_DATA_DIR` | `./data` | データベース・測定の記録・トークンの置き場所 |
| `POC_IVS_MODE` | `mock` | `mock`（代役）／`always-live`（配信なし）／`aws`（本物の IVS） |
| `IVS_CHANNEL_ARN` / `IVS_PLAYBACK_URL` / `AWS_REGION` | — | `aws` のときに使う |
| `POC_EVENTBRIDGE_SECRET` | — | EventBridge からの POST を確かめる合言葉。空なら受け口は閉じる |
| `POC_INCREMENT_TABLE` | P2-4 の例 | 入札単位の表（本仕様 OQ-14 が決まったら差し替える） |
| `POC_AUTO_STOP_MS` | 0 | 競りがない状態が続いたら配信を自動で止めるまでのミリ秒。0 は止めない（既定） |
| `POC_LIVE_SETTLE_MS` / `POC_LIVE_TIMEOUT_MS` | 8000 / 60000 | LIVE から受付中までの待ち／警告にするまで |
| `POC_VENUE_CONTACT` | — | 入札画面の下に出す会場の連絡先。空なら出さない |
| `POC_COMMENT_MAX_LENGTH` / `POC_COMMENT_INTERVAL_MS` | 20 / 3000 | コメントの長さの上限／続けて書き込めるまでの間隔 |
| `POC_METRICS` | full | 測定の記録の量。full／basic（端末ごとの送り返しを除く）／off |
| `POC_METRICS_MAX_MB` | 1024 | 測定の記録の全体の上限。超えたら古いファイルから消す |
| `POC_STREAM_IDLE_WARN_MS` | 600000 | 競りがないまま配信が続いたときに、進行コンソールに注意を出すまで |
| `POC_HEARTBEAT_MS` | 10000 | サーバーが端末の生存を確かめる間隔 |
| `POC_BID_RATE` | 5 | 会員1人あたりの入札の上限（1秒あたり）。0 で外す |
| `POC_MAX_CONNECTIONS` / `POC_MAX_CONNECTIONS_PER_USER` | 500 / 5 | 同時接続の上限（全体／同じ人） |
| `POC_ALLOWED_ORIGINS` | — | 別のドメインのページから接続させるとき、そのオリジンをカンマ区切りで |
| `POC_CSP` | on | ブラウザに守らせる読み込みの制限。off で外す |
| `POC_SITE_URL` | — | メールに載せるサイトの URL。空なら、主催者管理者が開催を公開したときのページの URL |
| `POC_MAIL_INTERVAL_MS` | 600 | 開催のお知らせメールを続けて送るときの間隔（送信サービスの速さの上限に当たらないように） |
| `POC_ALLOW_CRASH` | 0 | 1 で障害の模擬（強制終了）を許す。本番では必ず 0 |

秘密情報（IVS のストリームキー、obs-websocket のパスワード、AWS の認証情報、各トークン）は、ソースコードにもこのリポジトリにも書いていません。
ストリームキーは OBS の設定の中だけ、obs-websocket のパスワードは配信用PCの `agent/.env` だけに置きます。

## Cloudflare（workers.dev）で試す

GitHub に秘密の値を3つ入れて `deploy/cloudflare` ブランチへ push すると、配られる。データは R2 に自動で保存され、起動のたびに戻る。くわしくは `docs/03-PoC報告書.md` の 32 章。
