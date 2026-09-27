import { mcpProcessResourceSampleSource } from "./processResourceMcpTelemetrySource.js";
/**
 * 资源样本来源注册表。
 *
 * 新增来源时创建一个来源文件，并在下面的数组里追加一行，
 * 让并行开发的合并冲突压到相邻行级别。
 * 数组顺序不表达依赖：设备级来源要用的同 tick 事实由第二阶段的 `sampleDevice` 上下文提供。
 */

import { chromiumProcessResourceSampleSource } from "./processResourceChromiumSource.js";
import { cliProcessResourceSampleSource } from "./processResourceCliSource.js";
import { rendererHeapProcessResourceSampleSource } from "./processResourceRendererHeapSource.js";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";
import { selfHeapProcessResourceSampleSource } from "./processResourceSelfHeapSource.js";
import { systemProcessResourceSampleSource } from "./processResourceSystemSource.js";

export const PROCESS_RESOURCE_SAMPLE_SOURCES: readonly ProcessResourceSampleSource[] = [
  chromiumProcessResourceSampleSource,
  systemProcessResourceSampleSource,
  selfHeapProcessResourceSampleSource,
  rendererHeapProcessResourceSampleSource,
  cliProcessResourceSampleSource,
  mcpProcessResourceSampleSource,
];
