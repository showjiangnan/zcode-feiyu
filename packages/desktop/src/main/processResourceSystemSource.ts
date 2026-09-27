/**
 * 设备级样本来源。
 *
 * 与 Chromium 体系共用 main 的 10 秒 tick，跑在采样的第二阶段：
 * 相邻两个 tick 的 `os.cpus()` 快照差分得到整机 CPU、`os.freemem()` 得到整机剩余内存，
 * 再把第一阶段的精确合计与外部来源（CLI、MCP）的最近样本相加得到应用总量。
 * 全部为进程内 API，main 进程零外部进程。
 */

import os from "node:os";
import { addAppResourceTotals } from "./processResourceAppTotals.js";
import {
  collectExternalAppResourceTotals,
  resetExternalAppResourceSamples,
} from "./processResourceExternalAppSamples.js";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";
import { roundMetric } from "./resourceMetricsStats.js";

/** 整机 CPU 的累计时间快照；只有两次快照差分才是一段时间内的整机 CPU。 */
interface SystemCpuTimesSnapshot {
  busyMs: number;
  totalMs: number;
}

function summarizeSystemCpuTimes(cpus: readonly os.CpuInfo[]): SystemCpuTimesSnapshot {
  let busyMs = 0;
  let idleMs = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    busyMs += (times?.user ?? 0) + (times?.nice ?? 0) + (times?.sys ?? 0) + (times?.irq ?? 0);
    idleMs += times?.idle ?? 0;
  }
  return { busyMs, totalMs: busyMs + idleMs };
}

/**
 * 两次快照的差分百分比；拿不到可用差分时返回 null，调用方本 tick 不产生样本。
 * 返回 null 的情况：累计时间没有前进（容器里 `os.cpus()` 为空）、核数变化或时钟回拨导致差分为负。
 */
function diffSystemCpuPercent(
  previous: SystemCpuTimesSnapshot,
  next: SystemCpuTimesSnapshot,
): number | null {
  const totalDeltaMs = next.totalMs - previous.totalMs;
  const busyDeltaMs = next.busyMs - previous.busyMs;
  if (!(totalDeltaMs > 0) || busyDeltaMs < 0) {
    return null;
  }
  return roundMetric(Math.min(100, (busyDeltaMs / totalDeltaMs) * 100));
}

let previousCpuTimes: SystemCpuTimesSnapshot | null = null;

export const systemProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "system",
  sampleDevice(context) {
    const snapshot = summarizeSystemCpuTimes(os.cpus());
    const baseline = previousCpuTimes;
    previousCpuTimes = snapshot;

    // 第一个 tick 只有一个快照，差分无从谈起，因此不产生样本；
    // 第一阶段没有任何精确合计时同理——设备事件宁可少一个样本，也不上报半真的合计。
    if (!baseline || !context.appProcessTotals) {
      return;
    }
    const systemCpuPercent = diffSystemCpuPercent(baseline, snapshot);
    if (systemCpuPercent === null) {
      return;
    }

    const appTotals = addAppResourceTotals(
      context.appProcessTotals,
      collectExternalAppResourceTotals(context.now),
    );
    context.addDeviceSample({
      systemCpuPercent,
      systemFreeMemoryKb: Math.round(os.freemem() / 1024),
      appCpuPercent: appTotals.cpuPercent,
      appRssKbTotal: appTotals.rssKbTotal,
      appProcessCount: appTotals.processCount,
    });
  },
  reset() {
    // 丢弃 CPU 基线与外部来源的最近样本，避免用上一次采样会话的事实做差分与合计。
    previousCpuTimes = null;
    resetExternalAppResourceSamples();
  },
};
