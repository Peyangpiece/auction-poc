#!/usr/bin/env node
// OBS の代わりをする最小限の obs-websocket 5.x サーバー（開発・自動テスト用。認証なし）。
// 本物の OBS・IVS がない環境で、入札サーバー ⇄ 配信エージェント ⇄ OBS の流れを通すためだけのもの。
// P1 の判定には使えない（P1 は本物の OBS と IVS で測る）。
//   node tools/mock-obs.js --port 4455 --start-delay 800
import { WebSocketServer } from 'ws';

// scenes は、OBS の画面の上から順（GetSceneList は、OBS と同じく逆の順で返す）
export function startMockObs({ port = 4455, startDelayMs = 800, stopDelayMs = 300, scenes = ['カメラ: スマホ', 'カメラ: 無線', 'カメラ: USB', '休憩の画面'], video = {} } = {}) {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  const state = { active: false, timer: null, scenes: [...scenes], current: scenes[0] ?? null, video: { baseWidth: 1440, baseHeight: 1080, outputWidth: 1440, outputHeight: 1080, fpsNumerator: 30, fpsDenominator: 1, ...video } };
  const event = (eventType, eventData) => {
    const text = JSON.stringify({ op: 5, d: { eventType, eventIntent: 64, eventData } });
    for (const c of wss.clients) if (c.readyState === 1) c.send(text);
  };
  const setActive = (active, delay) => {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.active = active;
      event('StreamStateChanged', { outputActive: active, outputState: active ? 'OBS_WEBSOCKET_OUTPUT_STARTED' : 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
    }, delay);
  };
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.0.0-mock', rpcVersion: 1 } }));
    ws.on('message', (raw) => {
      const { op, d } = JSON.parse(raw);
      if (op === 1) return ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      if (op !== 6) return;
      let responseData = {};
      if (d.requestType === 'GetVersion') responseData = { obsVersion: 'mock', obsWebSocketVersion: '5.0.0-mock', rpcVersion: 1, platform: 'mock' };
      else if (d.requestType === 'GetStreamStatus') responseData = { outputActive: state.active, outputReconnecting: false };
      else if (d.requestType === 'StartStream') setActive(true, startDelayMs);
      else if (d.requestType === 'StopStream') setActive(false, stopDelayMs);
      else if (d.requestType === 'GetVideoSettings') responseData = { ...state.video };
      else if (d.requestType === 'SetVideoSettings') {
        // 本物の OBS と同じく、出力が動いている間は変えられない
        if (state.active) return ws.send(JSON.stringify({ op: 7, d: { requestType: d.requestType, requestId: d.requestId, requestStatus: { result: false, code: 500, comment: 'Video settings cannot be changed while an output is active.' } } }));
        // 本物の OBS（obs-websocket 5.x）と同じく、映像の設定が変わったことは知らせない
        Object.assign(state.video, d.requestData);
      }
      else if (d.requestType === 'GetSceneList') responseData = { currentProgramSceneName: state.current, scenes: [...state.scenes].reverse().map((sceneName, i) => ({ sceneName, sceneIndex: i })) };
      else if (d.requestType === 'SetCurrentProgramScene') {
        if (!state.scenes.includes(d.requestData?.sceneName)) return ws.send(JSON.stringify({ op: 7, d: { requestType: d.requestType, requestId: d.requestId, requestStatus: { result: false, code: 600, comment: 'No source was found' } } }));
        state.current = d.requestData.sceneName;
        setTimeout(() => event('CurrentProgramSceneChanged', { sceneName: state.current }), 10);
      }
      ws.send(JSON.stringify({ op: 7, d: { requestType: d.requestType, requestId: d.requestId, requestStatus: { result: true, code: 100 }, responseData } }));
    });
  });
  return { wss, state, close: () => new Promise((r) => { clearTimeout(state.timer); for (const c of wss.clients) c.terminate(); wss.close(r); }) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
  const port = arg('port', 4455);
  startMockObs({ port, startDelayMs: arg('start-delay', 800) });
  console.log(`[mock-obs] ws://127.0.0.1:${port}`);
}
