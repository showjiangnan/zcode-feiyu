// Modified by ZCode Feiyu contributors (2026).
import type { RuntimeCapability } from "@zcode/shared";

/**
 * 关窗后台运行的能力声明，只陈述 Host 能确定的事实：平台是否支持、有效策略是否开启。
 * Main 的就绪 / 运行 / 停止 / 失败状态在另一个进程，Host 没有读取通道，
 * 因此 available 只表示「允许」，此时 reason 明确写出未验证，避免调用方把它当成「此刻已在后台运行」（复审 DEF-21）。
 */
export function describeBackgroundContinuityCapability(input: {
  platform: NodeJS.Platform;
  continueAfterCloseOnMac: boolean | undefined;
  policyRevision: number | undefined;
}): RuntimeCapability {
  const supported = input.platform === "darwin";
  const enabled = input.continueAfterCloseOnMac === true;
  return {
    supported,
    enabled,
    available: supported && enabled,
    reason: !supported
      ? "platform_unsupported"
      : !enabled
        ? "disabled_by_policy"
        : "runtime_state_not_verified",
    policyRevision: input.policyRevision ?? 0,
  };
}
