/**
 * 「一批进程在某一刻的资源合计」这个值。
 *
 * 设备级 `perf_system_window` 的应用总量由两部分相加：main 能精确枚举的 Chromium 体系合计，
 * 与 CLI / MCP 这类外部来源最近一次已知样本的合计。两边是同一个值语义，所以只有这一份类型与相加逻辑。
 */

import { roundMetric } from "./resourceMetricsStats.js";

export interface AppResourceTotals {
  /** 这批进程的 CPU 之和（整机归一化百分比）。 */
  cpuPercent: number;
  rssKbTotal: number;
  processCount: number;
}

export function createEmptyAppResourceTotals(): AppResourceTotals {
  return { cpuPercent: 0, rssKbTotal: 0, processCount: 0 };
}

/** 相加两批合计；CPU 只在相加结束后取整，逐次 round 会让误差随进程数累积。 */
export function addAppResourceTotals(
  base: AppResourceTotals,
  extra: AppResourceTotals,
): AppResourceTotals {
  return {
    cpuPercent: roundMetric(base.cpuPercent + extra.cpuPercent),
    rssKbTotal: base.rssKbTotal + extra.rssKbTotal,
    processCount: base.processCount + extra.processCount,
  };
}
