// Modified by ZCode Feiyu.
import type { SessionEvent, HookRunLifecyclePayload } from "@zcode/contracts";
import type {
  ConversationDelta,
  HookInvocationRow,
  HookExecutionProjection,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionEventType } from "@zcode/contracts";
import { USER_PROMPT_HOOK_BLOCK_ERROR_TYPE } from "./product-projection-hook-invocation-row-content.js";
import type { ProductProjection } from "./product-projection.js";

export function hookBlockErrorDelta(
  this: ProductProjection,
  event: SessionEvent,
  payload: HookRunLifecyclePayload,
  didExecute: boolean,
  blockReason: string | undefined,
): ConversationDelta | null {
  if (
    event.type !== SessionEventType.HookRunBlocked ||
    payload.hookEventName !== "UserPromptSubmit" ||
    !didExecute ||
    !blockReason
  ) {
    return null;
  }
  const diagnosticMessage = [payload.stderrPreview, payload.errorMessage, payload.stdoutPreview]
    .map((value) => value?.trim())
    .find((value) => value && value !== blockReason);
  const displayReason = diagnosticMessage ?? blockReason;
  const message =
    displayReason === USER_PROMPT_HOOK_BLOCK_ERROR_TYPE
      ? USER_PROMPT_HOOK_BLOCK_ERROR_TYPE
      : `${USER_PROMPT_HOOK_BLOCK_ERROR_TYPE}: ${displayReason}`;
  const detail = [
    `Hook block reason: ${blockReason}`,
    ...(diagnosticMessage ? [`Hook error: ${diagnosticMessage}`] : []),
  ].join("\n");
  return {
    op: "state.updated",
    patch: this["controlPatch"]({
      lastError: {
        code: "fault.runtime.hookBlocked",
        message,
        recoverable: false,
        at: this["ms"](event),
        source: "runtime",
        traceId: String(event.traceId),
        ...(detail ? { detail } : {}),
        attribution: {
          source: "runtime",
          reason: "hook_blocked",
        },
      },
    }),
  };
}

export function flushPendingSessionHookInvocations(
  this: ProductProjection,
  turnId: string,
): ConversationDelta[] {
  if (this["pendingSessionHookInvocations"].size === 0) return [];
  const deltas: ConversationDelta[] = [];
  for (const [hookInvocationId, pending] of this["pendingSessionHookInvocations"]) {
    const row: HookInvocationRow = {
      ...this["rowBase"](pending.firstEvent, turnId, hookInvocationId),
      ...pending.content,
    };
    this["hookRowIdByInvocationId"].set(hookInvocationId, row.rowId);
    deltas.push({ op: "row.appended", row });
  }
  this["pendingSessionHookInvocations"].clear();
  return deltas;
}

export function hookExecutionState(
  this: ProductProjection,
  eventType: SessionEvent["type"],
): HookExecutionProjection["state"] {
  if (eventType === SessionEventType.HookRunFailed) return "failed";
  if (
    eventType === SessionEventType.HookRunCompleted ||
    eventType === SessionEventType.HookRunBlocked
  ) {
    return "completed";
  }
  return "running";
}

export function hookExecutionOutcome(
  this: ProductProjection,
  eventType: SessionEvent["type"],
  outcome: HookRunLifecyclePayload["outcome"],
): HookExecutionProjection["outcome"] {
  if (outcome) return outcome;
  if (eventType === SessionEventType.HookRunCompleted) return "success";
  if (eventType === SessionEventType.HookRunBlocked) return "blocked";
  if (eventType === SessionEventType.HookRunFailed) return "failed";
  return undefined;
}

export function hookInvocationState(
  this: ProductProjection,
  executions: readonly HookExecutionProjection[],
  hookCount: number,
): HookInvocationRow["state"] {
  if (
    executions.length < hookCount ||
    executions.some((execution) => execution.state === "running")
  ) {
    return "running";
  }
  return executions.some((execution) => execution.state === "failed") ? "failed" : "completed";
}

export function hookInvocationLane(
  this: ProductProjection,
  eventName: HookRunLifecyclePayload["hookEventName"],
): HookInvocationRow["lane"] {
  if (eventName === "PreToolUse" || eventName === "PermissionRequest") return "toolBefore";
  if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") return "toolAfter";
  return "assistantWork";
}

export function onRewindTriggered(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    targetMessageId?: string;
    scope?: string;
    branchCutAfterMessageId?: string;
    branchGeneration?: number;
    createdMessageId?: string;
    reason?: string;
  };
  if (payload.scope === "workspace" && payload.reason === "file_summary_rewind") {
    const targetMessageId = payload.targetMessageId;
    if (!targetMessageId) return [];
    const targetRowId = this["rowIdForMessageId"](targetMessageId);
    if (targetRowId === null) return [];
    const targetRow = this["findRow"](targetRowId);
    if (!targetRow) return [];
    const headerRowId = this["turnHeaderRowIdByTurnId"].get(targetRow.turnId);
    const headerRow = headerRowId !== undefined ? this["findRow"](headerRowId) : undefined;
    if (headerRow?.kind !== "turnHeader" || !headerRow.fileChanges) return [];
    return [
      {
        op: "row.upserted",
        row: {
          ...headerRow,
          fileChanges: {
            ...headerRow.fileChanges,
            state: "reverted",
          },
        },
      },
    ];
  }
  // 新语义只消费带 branchGeneration/cut 的已提交 conversation rewind；createdMessageId
  // 仅兼容旧 transcript。失败/冲突不发事件，因此不会制造 UI 假截断。
  const applied =
    (payload.branchGeneration !== undefined && payload.branchCutAfterMessageId !== undefined) ||
    payload.createdMessageId !== undefined;
  if ((payload.scope !== "conversation" && payload.scope !== "both") || !applied) return [];
  const targetMessageId = payload.targetMessageId;
  if (!targetMessageId) return [];
  const targetRowId = this["rowIdForMessageId"](targetMessageId);
  if (targetRowId === null) return [];
  const targetRow = this["findRow"](targetRowId);
  if (!targetRow) return [];
  // 从该行所属 turn 的首行起移除（整段 turn 被 rewind/edit/retry 替换）。
  const turnHeaderRowId = this["turnHeaderRowIdByTurnId"].get(targetRow.turnId) ?? targetRowId;
  const fromRowId = Math.min(turnHeaderRowId, targetRowId);
  // 清理被移除行的 messageId/tool 索引，避免悬挂映射。
  for (const [rowId] of this["messageIdByRowId"]) {
    if (rowId >= fromRowId) this["messageIdByRowId"].delete(rowId);
  }
  for (const [messageId, rowId] of this["outputContinuationRowIdByMessageId"]) {
    if (rowId >= fromRowId) this["outputContinuationRowIdByMessageId"].delete(messageId);
  }
  for (const [rowId, entityId] of this["entityIdByRowId"]) {
    if (rowId >= fromRowId) {
      this["entityIdByRowId"].delete(rowId);
      this["editTargetByEntityId"].delete(entityId);
    }
  }
  for (const [hookInvocationId, rowId] of this["hookRowIdByInvocationId"]) {
    if (rowId >= fromRowId) {
      this["rewoundHookInvocationIds"].add(hookInvocationId);
      this["hookRowIdByInvocationId"].delete(hookInvocationId);
    }
  }
  return [{ op: "row.removed", fromRowId }];
}

export function rowIdForMessageId(this: ProductProjection, messageId: string): number | null {
  const continuationRowId = this["outputContinuationRowIdByMessageId"].get(messageId);
  if (continuationRowId !== undefined) return continuationRowId;
  for (const [rowId, mid] of this["messageIdByRowId"]) {
    if (mid === messageId) return rowId;
  }
  return null;
}

export function getTurnRewindAnchor(this: ProductProjection, rowId: number): string | null {
  return this["rewindAnchorForRows"](this["snapshot"].rows.window, rowId);
}
