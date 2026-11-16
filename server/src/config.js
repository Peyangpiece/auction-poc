// 設定はすべて環境変数から読む。秘密情報をソースコードに書かない（引き継ぎ書「守ってほしいこと」5）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.POC_DATA_DIR || path.join(root, 'data'));
  return {
    root,
    port: num(env.PORT, 8080),
    host: env.HOST || '0.0.0.0',
    dataDir,
    dbPath: env.POC_DB_PATH || path.join(dataDir, 'auction.db'),
    metricsDir: env.POC_METRICS_DIR || path.join(dataDir, 'metrics'),
    webDir: path.join(root, 'web'),

    // 入札単位の表。本仕様 OQ-14 が未決のため、PoC 仕様書 P2-4 の【金額は例】を既定にする。
    // 形式: JSON 配列 [{"lt":10000,"unit":500},{"unit":1000}]（lt 未満ならその unit。lt なしは最後の帯）
    incrementTable: JSON.parse(env.POC_INCREMENT_TABLE || '[{"lt":10000,"unit":500},{"unit":1000}]'),

    // 配信の制御（本仕様 8.6、FR-STR-003）
    liveSettleMs: num(env.POC_LIVE_SETTLE_MS, 8000), // LIVE になってから受付中までの待ち時間（決定 v0.11: 8秒）
    liveTimeoutMs: num(env.POC_LIVE_TIMEOUT_MS, 60000), // LIVE にならないときに警告にするまで（決定 v0.11: 60秒）
    autoStopMs: num(env.POC_AUTO_STOP_MS, 180000), // 無操作で配信を止めるまで（OQ-05: 例の3分）
    agentCmdTimeoutMs: num(env.POC_AGENT_CMD_TIMEOUT_MS, 15000),

    // IVS の状態の取得（POC-IVS-001）。
    //   mock        : AWS を使わない。エージェントが報告した OBS の状態に、遅れを足して LIVE とみなす（開発・自動テスト用）
    //   always-live : 常に LIVE とみなす（P2 の正しさ・負荷の検証用。配信なしで競りだけを回す）
    //   aws         : (a) GetStream を1秒ごとに問い合わせ、(b) EventBridge のイベントも受け取る
    ivsMode: env.POC_IVS_MODE || 'mock',
    ivsMockDelayMs: num(env.POC_IVS_MOCK_DELAY_MS, 3000),
    ivsChannelArn: env.IVS_CHANNEL_ARN || '',
    ivsRegion: env.AWS_REGION || 'ap-northeast-1',
    ivsPollMs: num(env.POC_IVS_POLL_MS, 1000),
    ivsPlaybackUrl: env.IVS_PLAYBACK_URL || '', // 再生用の URL（秘密ではない。ストリームキーとは別物）
    ivsPlayerScriptUrl:
      env.IVS_PLAYER_SCRIPT_URL || 'https://player.live-video.net/1.58.0/amazon-ivs-player.min.js',
    // EventBridge の API destination から届く POST を確かめる合言葉（秘密。環境変数だけに置く）
    eventbridgeSecret: env.POC_EVENTBRIDGE_SECRET || '',

    // 障害の模擬（P2-3、P2-5、進行コンソールの「サーバーの再起動」）を許すか。本番では必ず 0 にする。
    allowCrash: env.POC_ALLOW_CRASH === '1',
    // 起動時から仕込む強制終了の位置（自動テスト用）: before_close_record | after_close_record
    crashAt: env.POC_CRASH_AT || '',

    // コメント: 長さの上限と、同じ会員が続けて書き込めるまでの間隔
    commentMaxLength: num(env.POC_COMMENT_MAX_LENGTH, 20),
    commentIntervalMs: num(env.POC_COMMENT_INTERVAL_MS, 3000),
    // 入札画面の下に出す会場の連絡先（主催者設定 FR-ORG-001 に当たる。PoC では環境変数で渡す）
    venueContact: env.POC_VENUE_CONTACT || '',

    sysSampleMs: num(env.POC_SYS_SAMPLE_MS, 10000),
  };
}
