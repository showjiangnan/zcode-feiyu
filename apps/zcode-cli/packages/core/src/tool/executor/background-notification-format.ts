// Modified by ZCode Feiyu.
import type { ExecutableToolCall } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { isRecord } from "./utils.js";
import { formatTaskNotification } from "../../runtime-task/notification.js";
import { isDynamicWorkflowRunDispatchToolName } from "./background-task-registry.js";
import { backgroundTaskOutputMetadata } from "./background-task-output.js";
import { type BackgroundTaskSnapshot } from "./background-task-types.js";
import { formatWorkflowTaskNotification } from "./background-workflow-notification.js";

import {
  normalizeBashTaskNotificationStatus,
  buildBackgroundTaskSummary,
} from "./background-notification-helpers.js";
export {
  isBackgroundTaskLaunch,
  normalizeBashTaskNotificationStatus,
  normalizeBackgroundTaskNotificationStatus,
  resolveBashBackgroundResultTitle,
  buildBackgroundTaskSummary,
  stringField,
  getBackgroundTaskWaiter,
  getWorkflowTaskWaiter,
  backgroundTaskKind,
} from "./background-notification-helpers.js";
// 按职责拆分；保留原始规则、执行顺序与状态所有者。

export function formatBackgroundTaskNotification(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  output?: Record<string, unknown>,
): string | undefined {
  // workflow run 复用 legacy Workflow 的通知格式（复用 formatWorkflowTaskNotification）。
  // legacy "Workflow" 保持独立并列：它没有 dwf 的产物/reports 语义，只在共享格式器里
  // 走自己的 output.response 回退分支。
  if (toolCall.name === "Workflow" || isDynamicWorkflowRunDispatchToolName(toolCall.name)) {
    return formatWorkflowTaskNotification(deps, toolCall, taskId, status, snapshot, output);
  }
  if (toolCall.name !== "Bash") return undefined;

  const input = isRecord(toolCall.input) ? toolCall.input : {};
  const command = typeof input.command === "string" ? input.command : undefined;
  const description = typeof input.description === "string" ? input.description : undefined;
  const result = snapshot && "result" in snapshot ? snapshot.result : undefined;
  const outputMetadata = backgroundTaskOutputMetadata(snapshot, output);
  const notificationStatus = normalizeBashTaskNotificationStatus(status);
  const summary = buildBackgroundTaskSummary({
    command,
    description,
    exitCode: result?.exitCode,
    lost: status === "lost",
    status: notificationStatus,
  });
  return formatTaskNotification({
    description,
    outputFile: outputMetadata.outputFile,
    status: notificationStatus,
    summary,
    taskId,
    taskType: "local_bash",
    toolUseId: toolCall.id,
  });
}
