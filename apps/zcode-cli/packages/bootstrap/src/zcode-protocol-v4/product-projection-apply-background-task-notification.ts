// Modified by ZCode Feiyu.
import type { CanonicalUserIntentFact } from "./event-normalizer.js";
import type {
  ConversationDelta,
  ToolCallRow,
  SessionControl,
  GoalState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  parseZCodeBackgroundTaskNotificationText,
  zcodeBackgroundTaskNotificationToolUpdateStatus,
} from "@zcode/shared";
import { buildToolOutput, mapTurnResultToHeaderState } from "./projection-rows.js";
import type { SessionEvent, TurnCompletePayload } from "@zcode/contracts";
import type { ProductProjection } from "./product-projection.js";

export function applyBackgroundTaskNotification(
  this: ProductProjection,
  fact: CanonicalUserIntentFact,
): ConversationDelta[] {
  const parsed = parseZCodeBackgroundTaskNotificationText(fact.input);
  if (!parsed) return [];
  const row = this["findToolRow"](parsed.toolUseId);
  if (!row) return [];
  const notificationStatus = zcodeBackgroundTaskNotificationToolUpdateStatus(
    parsed.notification.status,
  );
  const status: ToolCallRow["status"] =
    notificationStatus === "failed"
      ? "error"
      : notificationStatus === "stopped"
        ? "cancelled"
        : "success";
  const content =
    parsed.notification.result ?? parsed.notification.summary ?? parsed.notification.error;
  const next: ToolCallRow = {
    ...row,
    status,
    ...(content
      ? {
          output: buildToolOutput({ success: status === "success", content }, parsed.toolUseId),
        }
      : {}),
    endedAt: this["ms"](fact.event),
  };
  if (status === "error") {
    next.error = {
      code: "fault.runtime.backgroundTaskFailed",
      message: parsed.notification.error ?? content ?? "Background task failed.",
    };
  } else {
    delete next.error;
  }
  return [{ op: "row.upserted", row: next }];
}

export function onTurnComplete(this: ProductProjection, event: SessionEvent): ConversationDelta[] {
  const payload = event.payload as TurnCompletePayload;
  this["outputContinuationTextRowId"] = null;
  const headerState = mapTurnResultToHeaderState(payload.resultType);
  const header = this["turnHeaderForEvent"](event);
  if (header?.executionKind === "controlOnly") {
    // controlOnly 没有 Agent 工时；尤其不能把 duration=0 下发给旧 UI，后者会为了
    // 可读性把 0 秒格式化成“已工作 1 秒”。这里只收口可见轮次，不碰 session control——
    // 除了 draft 的离场（见 leaveDraftAfterControlOnlyTurn）。
    const deltas = [
      ...this["upsertTurnHeader"](event, headerState, undefined, payload.historyRoundCount),
      ...this["leaveDraftAfterControlOnlyTurn"](
        payload.resultType === "success" ? "completedSuccess" : "completedInterrupted",
      ),
    ];
    this["currentTurnId"] = null;
    // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
    this["currentTurnStartedModelOnly"] = false;
    return deltas;
  }
  const phase: SessionControl["phase"] =
    payload.resultType === "success"
      ? "completedSuccess"
      : payload.resultType === "cancelled"
        ? "completedInterrupted"
        : "error";
  const streamClose = payload.resultType === "success" ? "complete" : "interrupted";
  const activeMs = this["activeMsForCompletion"](event, payload.duration);
  // stopPausesActiveGoalTarget：stop 作用于任何 foreground work 时，
  // active/verifying 的 goal 强制进入 paused，等待显式 resumeGoal。
  const goal = this["snapshot"].goal;
  const pausedGoal: GoalState | undefined =
    payload.resultType === "cancelled" &&
    (goal?.status === "active" || goal?.status === "verifying")
      ? { ...goal, status: "paused" }
      : undefined;
  // stopKeepsQueueAndDisablesAutoDrain（stop 效果）：中断后 queue 原样保留
  // 且不自动消费 → 形成暂停队列；pauseReason 只用于 UI 解释原因，不参与路由裁决。
  const heldQueue =
    payload.resultType === "cancelled" &&
    payload.preserveQueueAutoDrainOnCancel !== true &&
    this["snapshot"].queue.items.length > 0 &&
    (this["snapshot"].queue.autoDrain || this["snapshot"].queue.pauseReason !== "stopped")
      ? {
          ...this["snapshot"].queue,
          autoDrain: false,
          pauseReason: "stopped" as const,
        }
      : undefined;
  const deltas: ConversationDelta[] = [
    ...this["closeStreamingRows"](streamClose),
    // turn 终态一并收口在飞的 foreground tool row（收口不变量：被 profile
    // 过滤的 inputText 流必须被不可过滤的 row.upserted 蕴含，见 profiles.ts）。
    ...this["closeOpenToolRows"](event, payload.resultType === "cancelled" ? "cancelled" : "error"),
    ...this["upsertTurnHeader"](
      event,
      headerState,
      activeMs,
      payload.historyRoundCount,
      this["highspeedTimingForTurn"](this["turnIdOf"](event), activeMs),
    ),
    ...(payload.resultType === "success" ? this["markStableForkAssistant"](event) : []),
    {
      op: "state.updated",
      patch: this["controlPatch"](
        {
          phase,
          sessionEnded: phase !== "error",
          canStop: false,
          stopState: "idle",
          stopTargetKind: "unknown",
          activeWorks: [],
          // 旧 V4 reducer 没有消费 ModelNetworkStatus，补投影后若 turn
          // 直接进入终态仍不清理，会让“重新连接中”残留到下一轮。
          apiRetry: null,
        },
        pausedGoal,
        heldQueue,
      ),
    },
  ];
  this["currentTurnId"] = null;
  // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
  this["currentTurnStartedModelOnly"] = false;
  return deltas;
}

export function leaveDraftAfterControlOnlyTurn(
  this: ProductProjection,
  phase: Exclude<SessionControl["phase"], "draft" | "prewarming" | "running">,
): ConversationDelta[] {
  if (this["snapshot"].control.phase !== "draft") return [];
  return [
    {
      op: "state.updated",
      patch: this["controlPatch"]({
        phase,
        sessionEnded: phase !== "error",
        canStop: false,
        stopState: "idle",
        stopTargetKind: "unknown",
        activeWorks: [],
      }),
    },
  ];
}
