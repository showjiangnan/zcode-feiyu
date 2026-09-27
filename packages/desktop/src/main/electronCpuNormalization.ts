/**
 * Electron `percentCPUUsage` 的整机口径归一化。
 *
 * 资源管理器 UI 展示的整机 CPU 口径统一走这一份归一化实现：
 * darwin / win32 上 Chromium 已按整机归一化；linux 上是单核口径，需要除以逻辑核数。
 */

import os from "node:os";

export function normalizeElectronCpuToMachinePercent(
  cpu: number | null | undefined,
  options: { platform?: NodeJS.Platform; logicalCpuCount?: number } = {},
): number {
  const normalizedCpu = typeof cpu === "number" && Number.isFinite(cpu) ? cpu : 0;
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    return normalizedCpu;
  }
  const logicalCpuCount = options.logicalCpuCount ?? os.cpus().length;
  const scale = Number.isFinite(logicalCpuCount) && logicalCpuCount > 0 ? logicalCpuCount : 1;
  return normalizedCpu / scale;
}
