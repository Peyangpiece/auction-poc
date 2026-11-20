// 請求書の PDF・Excel を、別のスレッドで作る（報告書 118 章）。
// 競りと同じスレッドで作ると、1通につき 0.05〜0.12 秒、入札の受け付けが止まっていた（当日現金の精算は、競りの最中に行う）。
import { parentPort } from 'node:worker_threads';
import { makeInvoiceFiles } from './invoice-files.js';

parentPort.on('message', async ({ id, args }) => {
  try {
    await makeInvoiceFiles(args).done;
    parentPort.postMessage({ id, ok: true });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String(err?.message ?? err) });
  }
});
