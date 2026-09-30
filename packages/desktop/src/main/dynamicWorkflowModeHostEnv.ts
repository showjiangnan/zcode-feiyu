// Modified by ZCode Feiyu contributors (2026).
import { ZCODE_DYNAMIC_WORKFLOW_MODE_ENV, normalizeDynamicWorkflowMode } from "@zcode/shared";

/** Desktop main owns the local Host override before the Host process starts. */
export function resolveDynamicWorkflowModeHostEnv(options: {
  inheritedValue: string | undefined;
  isPackaged: boolean;
  isPreview: boolean;
}): Record<string, string> {
  if (options.isPackaged) {
    // Production 与 Preview 安装版都应默认开放；不能让继承的 shell 值关闭它。
    return { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: "alwaysOn" };
  }
  const mode = normalizeDynamicWorkflowMode(options.inheritedValue);
  return mode ? { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: mode } : {};
}
