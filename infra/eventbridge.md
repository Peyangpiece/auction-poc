# IVS の状態を EventBridge で受け取る設定（POC-IVS-001 の方法 (b)）

IVS のイベントは、チャンネルと同じリージョン（東京）の既定のイベントバスに届く。Lightsail のサーバーは AWS の中のサービスから直接呼べないので、
EventBridge の「API destination」で、入札サーバーの `https://<ドメイン>/hooks/ivs` に POST させる。

下のコマンドとイベントの形は、公式の資料を見ずに書いた下書きで、**【未検証】**。PoC の手順2で実物を確かめ、違っていたら直す。

```bash
# 1. 接続（合言葉のヘッダーを付けさせる）。値は /etc/auction-poc.env の POC_EVENTBRIDGE_SECRET と同じにする
aws events create-connection --region ap-northeast-1 --name auction-poc-ivs \
  --authorization-type API_KEY \
  --auth-parameters 'ApiKeyAuthParameters={ApiKeyName=x-poc-secret,ApiKeyValue=<合言葉>}'
```

```bash
# 2. 送り先
aws events create-api-destination --region ap-northeast-1 --name auction-poc-ivs \
  --connection-arn <1 の ConnectionArn> \
  --invocation-endpoint https://<ドメイン>/hooks/ivs --http-method POST
```

```bash
# 3. ルール（IVS のストリームの状態の変化だけ）
aws events put-rule --region ap-northeast-1 --name auction-poc-ivs-state \
  --event-pattern '{"source":["aws.ivs"],"detail-type":["IVS Stream State Change"]}'
```

```bash
# 4. ルールの送り先に 2 を指定する（events:InvokeApiDestination を許したロールが要る）
aws events put-targets --region ap-northeast-1 --rule auction-poc-ivs-state \
  --targets 'Id=1,Arn=<2 の ApiDestinationArn>,RoleArn=<ロールの ARN>'
```

サーバーが見ている項目（`server/src/stream.js` の `onEventBridge`）:

| 項目 | 期待している値 | 確かめること |
|---|---|---|
| `detail-type` | `IVS Stream State Change` | 実際の文字列 |
| `detail.event_name` | `Stream Start` / `Stream End` | 実際の文字列。`Session Created` などほかの値が先に来るか |
| `resources[]` | チャンネルの ARN を含む | 含まれるか |
| `time` | イベントの発生時刻 | 受け取った時刻との差（イベントの遅れ） |

届いたイベントはすべて、測定の記録に `ivs_event` として残る（中身の確認に使える）。

GetStream（方法 (a)）に要る権限は `ivs:GetStream` だけ。配信していないチャンネルで `ChannelNotBroadcasting` が返ることも【未検証】。
違う名前の例外が返った場合は、記録の `ivs_poll_error` に名前が残る。
