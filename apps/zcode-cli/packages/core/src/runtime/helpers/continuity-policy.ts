// Modified by ZCode Feiyu contributors (2026).
import type { ContinuityPolicy } from "@zcode/shared";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * 读取 runtime 当前有效的连续性策略与修订。
 *
 * 顶层 runtime 直接读自己的配置；内部子 runtime 通过根 runtime 提供的读取函数取得，
 * 所以设置确认（收紧或放宽）对根生效的同一刻，其全部子 runtime 的下一次准入即按新策略执行。
 */
export function resolveContinuityPolicy(
  runtime: Pick<AgentRuntimeInternal, "config" | "continuityPolicySource">,
): { policy?: ContinuityPolicy; revision?: number } {
  return (
    runtime.continuityPolicySource?.() ?? {
      policy: runtime.config.continuityPolicy,
      revision: runtime.config.continuityPolicyRevision,
    }
  );
}
