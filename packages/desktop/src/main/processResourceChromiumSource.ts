/**
 * Chromium 体系（main / renderer / gpu / utility）的资源样本来源。
 *
 * 每 10 秒读一次 `app.getAppMetrics()`，按角色聚合后喂给窗口聚合器。
 * main 进程零外部进程，这里只有进程内 API。
 */

import { app, type ProcessMetric } from "electron";
import os from "node:os";
import { normalizeElectronCpuToMachinePercent } from "./electronCpuNormalization.js";
import {
  aggregateChromiumProcessRoles,
  sumChromiumRoleAggregates,
  type ChromiumProcessMetricSample,
} from "./processResourceRoleClassifier.js";
import { collectChromiumProcessRolePids } from "./resourceManagerWindow.js";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";

function toNormalizedSample(
  metric: ProcessMetric,
  logicalCpuCount: number,
): ChromiumProcessMetricSample {
  return {
    pid: metric.pid,
    type: metric.type,
    cpuPercent: normalizeElectronCpuToMachinePercent(metric.cpu.percentCPUUsage, {
      logicalCpuCount,
    }),
    // getAppMetrics 的 memory.workingSetSize 单位为 KB。
    rssKb: metric.memory.workingSetSize ?? 0,
    creationTime: metric.creationTime,
  };
}

export const chromiumProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "chromium",
  sample(context) {
    const metrics = app.getAppMetrics();
    const logicalCpuCount = os.cpus().length;
    const aggregates = aggregateChromiumProcessRoles({
      processes: metrics.map((metric) => toNormalizedSample(metric, logicalCpuCount)),
      pids: collectChromiumProcessRolePids(),
      now: context.now,
    });

    // ChromiumRoleAggregate 就是 ProcessRoleSample 的 Chromium 子集（无 heap / mcpId / hardware），
    // 逐字段搬运只会让两处字段名漂移时静默出错。
    for (const aggregate of aggregates) {
      context.addRoleSample(aggregate);
    }
    // 设备级事件的应用总量要的是本 tick 的精确合计；采样抛错时这一行不会执行，
    // 该 tick 就没有设备样本，绝不拿旧读数充当当前事实。
    context.addAppProcessTotals(sumChromiumRoleAggregates(aggregates));
  },
};
