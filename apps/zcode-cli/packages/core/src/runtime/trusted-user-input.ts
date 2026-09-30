// Modified by ZCode Feiyu contributors (2026).
import { isTaskRoot } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";
import type { ExecuteTurnOptions } from "./types.js";
/** 身份来自执行端 metadata；自动任务的正文不能冒充用户操作以解除暂停。 */
export function isTrustedUserInput(
  runtime: AgentRuntimeInternal,
  options?: ExecuteTurnOptions,
): boolean {
  return (
    isTaskRoot(runtime.config.taskType, runtime.config.parentSessionId) &&
    !options?.inputSource &&
    options?.inputVisibility !== "model-only" &&
    (!options?.inputPresentation || options.inputPresentation === "user_steer") &&
    !options?.intent?.interTaskSourceTaskId &&
    !options?.automationId &&
    !options?.offPeakTaskId &&
    !options?.originMeta &&
    !options?.backgroundSource &&
    !options?.backgroundSubagentResultConsumed &&
    !options?.workflowResultConsumed &&
    !["task-app:", "mailbox:", "automation:", "offpeak:"].some((prefix) =>
      (options?.intent?.sourceCommandId ?? options?.inputId)?.startsWith(prefix),
    )
  );
}
