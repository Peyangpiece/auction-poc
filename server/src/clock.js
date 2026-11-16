// 時刻はすべて UTC のエポックミリ秒（小数3桁まで）で扱う（本仕様 DATA-002、PoC 仕様書 6章）。
import { performance } from 'node:perf_hooks';

/** 現在時刻（エポックミリ秒、小数つき）。Date.now() より細かく、同じ基準で単調に進む。 */
export function nowMs() {
  return Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000;
}
