// Modified by ZCode Feiyu.
import { traceContextToLogContext, TurnMachineImpl } from "../deps.js";

import { createRuntimeAssistantEntry } from "../../agent/message-history.js";
import {
  projectExecutionErrorPayload,
  throwIfTurnAborted,
  isModelContextExceededError,
  isTurnCancellationError,
} from "../helpers/index.js";
import type { RuntimeModelStreamSnapshot } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

import { persistCancelledStreamSnapshot } from "./cancelled-stream-persistence.js";
import {
  beginStartPlanBusyAdmissionRetryAttempt,
  createStartPlanBusyAutoRetryExhaustedError,
  emitStreamRecoveryRetryEvents,
  emitStreamRecoveryStarted,
  getStartPlanBusyAdmissionRetryDelayMs,
  isStartPlanBusyStreamRecoveryFailure,
} from "./streaming-recovery.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { recordModelHistoryRound } from "./turn-loop-state.js";
import { recordMainTurnModelUsage } from "./turn-model-step-usage.js";

import {
  applyExecutionSelectionFallback,
  matchExecutionSelectionFallback,
} from "./turn-execution-fallback.js";
import {
  commitTurnRequestEntries,
  completeOutputTokenRecovery,
  hasAssistantReasoningContent,
} from "./turn-output-token-continuation.js";
import type {
  ModelStepContext,
  ModelStepOptions,
  ModelStepResult,
} from "./turn-model-step-types.js";
import { recoverModelStepAfterContextExceeded } from "./turn-model-step-overflow.js";
export async function recoverFailedModelStep(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: ModelStepOptions,
  error: unknown,
  context: Pick<
    ModelStepContext,
    | "model"
    | "modelStepIndex"
    | "modelStartedAt"
    | "assistantCreatedAt"
    | "assistantMessageId"
    | "executionModelSelection"
    | "modelTraceContext"
    | "networkEventStartIndex"
    | "streamingToolCoordinator"
  > & {
    latestStreamSnapshot: RuntimeModelStreamSnapshot;
    latestModelRequestId?: string;
    latestFailedModelRequestId?: string;
  },
): Promise<ModelStepResult> {
  const {
    model,
    modelStepIndex,
    modelStartedAt,
    assistantCreatedAt,
    assistantMessageId,
    executionModelSelection,
    modelTraceContext,
    networkEventStartIndex,
    streamingToolCoordinator,
    latestStreamSnapshot,
    latestModelRequestId,
    latestFailedModelRequestId,
  } = context;

  let finalError = error;
  await recordMainTurnModelUsage(this, state, {
    assistantMessageId,
    error: finalError,
    model,
    modelTraceContext,
    networkEventStartIndex,
    startedAt: modelStartedAt,
    status: state.turnAbortSignal.aborted ? "cancelled" : "error",
  });
  const failedRequestId = latestFailedModelRequestId ?? latestModelRequestId;
  // 执行 Selection 的声明式退回必须先于同模型 stream recovery：明确归因到加速 provider/network
  // 边界的请求失败都要退回会话模型（spec §2.2）。若 recovery 在前，流中断后会先在加速模型上
  // 重试到预算耗尽，降级形同虚设。
  const selectionFallbackMatch = matchExecutionSelectionFallback({
    error: finalError,
    executionProviderId: String(executionModelSelection.providerId),
    selectionFallback: state.selectionFallback,
    turnAborted: state.turnAbortSignal.aborted,
  });
  const toolCallCountBeforeSelectionFallback = state.toolCallCount;
  const selectionFallbackResult = selectionFallbackMatch
    ? await applyExecutionSelectionFallback(this, state, {
        assistantCreatedAt,
        assistantMessageId,
        error: finalError,
        executionModel: model,
        match: selectionFallbackMatch,
        modelTraceContext,
        streamingToolCoordinator,
      })
    : undefined;
  if (selectionFallbackResult?.applied) {
    // Bug 根因：fallback settlement 已提交工具结果并建立新 anchor，却继承了此前 length 链的计数，
    // 使退回模型第一次截断就可能提前耗尽。只按工具计数增量重置，纯文本 tail discard 不绕过上限。
    if (state.toolCallCount > toolCallCountBeforeSelectionFallback) {
      completeOutputTokenRecovery(state.turnRequestState);
    }
    return "continue";
  }
  const toolCallCountBeforeStreamRecovery = state.toolCallCount;
  // Bug 根因：退回目标解析失败后若继续进入通用恢复，会重新请求同一个已失败的 execution provider。
  // 命中声明就已消费本轮恢复决策；无处可退必须保留原错误并直接失败。
  if (
    !selectionFallbackMatch &&
    (await streamingToolCoordinator.recoverFromModelFailure(
      error,
      assistantCreatedAt,
      failedRequestId ? { failedRequestId } : undefined,
    ))
  ) {
    if (state.toolCallCount > toolCallCountBeforeStreamRecovery) {
      completeOutputTokenRecovery(state.turnRequestState);
    }
    return "continue";
  }
  const admissionRetryDelayMs = getStartPlanBusyAdmissionRetryDelayMs({
    error: finalError,
    providerId: executionModelSelection.providerId,
    state,
    turnNumber: this.turnNumber,
  });
  if (
    !selectionFallbackMatch &&
    !state.turnAbortSignal.aborted &&
    admissionRetryDelayMs !== undefined
  ) {
    // 第二轮及以后 Start Plan 可能在首 token 前被 admission 并发限制拒绝；
    // 这时没有文本或 tool anchor，旧 stream recovery 不会启动，必须关闭空 assistant 后短重试。
    const recoveryAttempt = beginStartPlanBusyAdmissionRetryAttempt(state);
    this.logger?.warn("Main turn retrying after Start Plan admission busy", {
      ...traceContextToLogContext(modelTraceContext),
      event: "model.main_turn.retry_start_plan_admission_busy",
      module: "core.runtime",
      retryDelayMs: admissionRetryDelayMs,
      retryNumber: recoveryAttempt.retryNumber,
      maxRetries: recoveryAttempt.maxRetries,
      status: "waiting",
    });
    await emitStreamRecoveryStarted(
      this,
      state,
      {
        assistantMessageId,
        ...(failedRequestId ? { failedRequestId } : {}),
        traceContext: modelTraceContext,
      },
      finalError,
      recoveryAttempt,
    );
    await this.persistAssistantMessage(
      assistantMessageId,
      state.userMessageId,
      assistantCreatedAt,
      {
        completed: Date.now(),
        finish: "start_plan_admission_retry_discarded",
      },
      modelTraceContext,
      model,
    );
    state.modelResponse = "";
    state.modelStepCount += 1;
    recordModelHistoryRound(state);
    state.turnMachine = new TurnMachineImpl(state.turnMachine.receiveModelResponse(""));
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
    await emitStreamRecoveryRetryEvents(
      this,
      state,
      {
        assistantMessageId,
        ...(failedRequestId ? { failedRequestId } : {}),
        traceContext: modelTraceContext,
      },
      {
        ...recoveryAttempt,
        discardedReasoningBytes: 0,
        discardedTextBytes: 0,
        reason: "no_tool_committed",
        toolCallIds: [],
      },
    );
    await streamingToolCoordinator.abandon("model_failed");
    await new Promise((resolve) => setTimeout(resolve, admissionRetryDelayMs));
    throwIfTurnAborted(state.turnAbortSignal);
    return "continue";
  }
  if (
    !selectionFallbackMatch &&
    state.streamRecoveryRetryCount > 0 &&
    !state.turnAbortSignal.aborted &&
    isStartPlanBusyStreamRecoveryFailure(finalError)
  ) {
    // Start Plan 运行中断流会先走 core stream recovery；恢复次数耗尽后，
    // 继续抛原 provider 文案会和首轮繁忙失败无法区分，UI 也就不能展示“自动重试达到最大次数”。
    finalError = createStartPlanBusyAutoRetryExhaustedError(finalError);
  }
  // 无 fallback target 时工具已在上方 settlement；再次 abandon 会发布与终态矛盾的 ledger 事件。
  if (!selectionFallbackResult?.settledAcceptedTools) {
    await streamingToolCoordinator.abandon(
      state.turnAbortSignal.aborted ? "cancelled" : "model_failed",
    );
  }
  if (state.turnAbortSignal.aborted && isTurnCancellationError(finalError, state.turnAbortSignal)) {
    await persistCancelledStreamSnapshot(this, {
      assistantCreatedAt,
      assistantMessageId,
      snapshot: latestStreamSnapshot,
      traceContext: modelTraceContext,
    });
    const reasoning = latestStreamSnapshot.reasoning.filter(hasAssistantReasoningContent);
    if (latestStreamSnapshot.text.length > 0 || reasoning.length > 0) {
      // 取消时 durable snapshot 已经持久化，但成功路径的 live history commit
      // 和 historyRoundCount 不会执行，导致当前进程与 cold resume 的 provider history 不一致。
      commitTurnRequestEntries(this, state.turnRequestState, [
        createRuntimeAssistantEntry(
          latestStreamSnapshot.text,
          undefined,
          reasoning,
          state.model
            ? { providerId: state.model.providerId, modelId: state.model.modelId }
            : undefined,
        ),
      ]);
      recordModelHistoryRound(state);
    }
  }
  const finalErrorRecord =
    finalError && typeof finalError === "object"
      ? (finalError as Record<string, unknown>)
      : undefined;
  const persistedErrorCode =
    typeof finalErrorRecord?.code === "string" ? finalErrorRecord.code : undefined;
  const persistedErrorProjection = projectExecutionErrorPayload(finalError);
  const persistedTurnResult = isTurnCancellationError(finalError, state.turnAbortSignal)
    ? "cancelled"
    : undefined;
  await this.persistAssistantMessage(
    assistantMessageId,
    state.userMessageId,
    assistantCreatedAt,
    {
      completed: Date.now(),
      error: {
        name: finalError instanceof Error ? finalError.name : "UnknownError",
        data: {
          message: finalError instanceof Error ? finalError.message : String(finalError),
          ...(persistedErrorCode ? { code: persistedErrorCode } : {}),
          // live TurnError 有结构化归因，但 transcript 过去未持久化，冷恢复后会丢成 runtime。
          ...(persistedErrorProjection.attribution
            ? { attribution: persistedErrorProjection.attribution }
            : {}),
          // 用户 Stop 的模型中止过去只持久化通用 error name/message，
          // cold hydration 无法区分正常取消和真实 provider 失败，最终错误地生成 TurnError。
          ...(persistedTurnResult ? { turnResult: persistedTurnResult } : {}),
        },
      },
    },
    modelTraceContext,
    model,
  );
  if (
    isModelContextExceededError(finalError) &&
    (await recoverModelStepAfterContextExceeded.call(
      this,
      state,
      finalError,
      modelStepIndex,
      options.requestEntries,
    ))
  ) {
    return "continue";
  }
  throw finalError;
}
