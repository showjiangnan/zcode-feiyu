// Modified by ZCode Feiyu.
import { SessionEventType as EventTypes } from "./session.events.js";
import type {
  ModelCompletePayload,
  TargetChangedPayload,
  TargetCompletionVerificationPayload,
} from "./session.events.js";
import {
  GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
  parseGoalCompletionVerificationText,
  failedGoalCompletionVerification,
} from "../tools/target.js";
import { getModelUsageContextTokens } from "../model/index.js";
import {
  applyStreamingToolLedgerUpdate,
  applyStreamRecoveryAnchorCreated,
} from "./event-reducer-helpers.js";
import type {
  StreamingToolLedgerPayload,
  StreamRecoveryAnchorPayload,
} from "./stream-recovery.events.js";
import type { EventProjectionHandler } from "./event-reducer-handler.js";

function shouldModelCompleteUpdateContextUsed(payload: ModelCompletePayload): boolean {
  if (payload.querySource !== undefined) {
    return payload.querySource === "main_turn";
  }

  // 兼容旧版主会话事件没有 querySource 的历史数据；工具/子任务内部模型调用
  // 过去也可能缺这个字段，但 stopReason 会标成 tool_internal，不能拿来覆盖主 session。
  return payload.stopReason !== "tool_internal";
}

export function createModelGoalProjectionHandlers(): Record<string, EventProjectionHandler> {
  return {
    [EventTypes.ModelComplete]: (p, e) => {
      const payload = e.payload as ModelCompletePayload;
      if (payload.querySource === GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE) {
        return {
          ...p,
          targetCompletionVerifications: [
            ...p.targetCompletionVerifications,
            parseGoalCompletionVerificationText(payload.content),
          ],
          updatedAt: e.timestamp,
        };
      }
      // 输入栏 context usage 只代表主会话发给 provider 的最新上下文。
      // 标题生成、压缩摘要、子代理和工具内部模型调用都不是当前主 session 的可见上下文，
      // 如果用它们的 usage 覆盖 projection，UI 会显示成 89/1m 这类 sidecar 小请求。
      if (!shouldModelCompleteUpdateContextUsed(payload)) {
        return {
          ...p,
          updatedAt: e.timestamp,
        };
      }
      // AI SDK v6 的 provider input 已经是 total input（含 cache read/write）；
      // 这里通过统一 helper 计算 context used，避免各处重复理解 cache breakdown。
      const contextUsed = getModelUsageContextTokens(payload.usage);
      return {
        ...p,
        ...(contextUsed !== undefined ? { contextUsed } : {}),
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.StreamingToolLedgerUpdated]: (p, e) => {
      return applyStreamingToolLedgerUpdate(
        p,
        e.payload as StreamingToolLedgerPayload,
        e.timestamp,
      );
    },

    [EventTypes.StreamRecoveryAnchorCreated]: (p, e) => {
      return applyStreamRecoveryAnchorCreated(
        p,
        e.payload as StreamRecoveryAnchorPayload,
        e.timestamp,
      );
    },

    [EventTypes.TargetChanged]: (p, e) => {
      const payload = e.payload as TargetChangedPayload;
      const targetChanged =
        payload.action === "set" && payload.previousTarget?.targetID !== payload.target?.targetID;
      return {
        ...p,
        target: payload.target,
        targetCompletionVerifications: targetChanged ? [] : p.targetCompletionVerifications,
        targetCompletionVerificationTimeline: targetChanged
          ? []
          : p.targetCompletionVerificationTimeline,
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.TargetCompletionVerification]: (p, e) => {
      const payload = e.payload as TargetCompletionVerificationPayload;
      const existing = p.targetCompletionVerificationTimeline.find(
        (item) =>
          item.verificationId === payload.verificationId ||
          (payload.goalIteration !== undefined &&
            item.targetId === payload.targetId &&
            item.goalIteration === payload.goalIteration),
      );
      const startedAt =
        existing?.startedAt ?? (payload.status === "started" ? e.timestamp : undefined);
      // goal 校验的 UI 身份是 target + iteration；verificationId 只是单次尝试。
      // started/completed 或恢复重放如果只按 verificationId 合并，会把同一轮目标校验追加成多条横线。
      const goalIteration =
        payload.goalIteration ??
        existing?.goalIteration ??
        p.targetCompletionVerificationTimeline.length + 1;
      const nextTimelineItem = {
        targetId: payload.targetId,
        status: payload.status,
        verificationId: payload.verificationId,
        ...(payload.verification ? { verification: payload.verification } : {}),
        goalIteration,
        ...((payload.anchorAssistantMessageId ?? existing?.anchorAssistantMessageId)
          ? {
              anchorAssistantMessageId:
                payload.anchorAssistantMessageId ?? existing?.anchorAssistantMessageId,
            }
          : {}),
        ...((payload.anchorTurnId ?? existing?.anchorTurnId)
          ? { anchorTurnId: payload.anchorTurnId ?? existing?.anchorTurnId }
          : {}),
        ...(startedAt ? { startedAt } : {}),
        updatedAt: e.timestamp,
      };
      const nextTimeline = existing
        ? p.targetCompletionVerificationTimeline.map((item) =>
            item === existing ? nextTimelineItem : item,
          )
        : [...p.targetCompletionVerificationTimeline, nextTimelineItem];
      return {
        ...p,
        // failed_closed/cancelled 没有 model_complete 结果事件，必须把 lifecycle 结论补进摘要账本；
        // 正常 completed 继续由既有 model_complete 投影，避免新旧事件把同一次校验计两遍。
        targetCompletionVerifications:
          payload.status === "failed_closed" || payload.status === "cancelled"
            ? [
                ...p.targetCompletionVerifications,
                payload.verification ??
                  failedGoalCompletionVerification(
                    "The completion verifier did not return a persisted result.",
                  ),
              ]
            : p.targetCompletionVerifications,
        targetCompletionVerificationTimeline: nextTimeline,
        updatedAt: e.timestamp,
      };
    },
  };
}
