// Modified by ZCode Feiyu.
import {
  SessionEventType,
  createModelUsageSummaryFromEvents,
  traceContextToLogContext,
} from "../deps.js";

import type { TurnResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { completeSuggestedPromptTurn } from "../suggested-prompt/runtime.js";

import { runRegularTurnLoop } from "./turn-loop.js";
import { maybeStartDeferredSessionTitleGeneration } from "./session-title.js";
import { finishOutputTokenRecovery } from "./turn-output-token-continuation.js";
import { recordTurnUsageFact } from "./usage-observability.js";
import { persistStableForkCompletionBoundary } from "./stable-fork-boundary.js";
import {
  closeGoalStateChangeReminderDeferral,
  openGoalStateChangeReminderDeferral,
} from "./goal-state-reminder.js";
import { scheduleProjectMemoryExtraction } from "../helpers/project-memory-extraction.js";
import { runProjectMemoryReview } from "../helpers/project-memory-review.js";
import { appendBrowserTurnScreenshot } from "./browser-turn-screenshot.js";

import type { RegularTurnExecutionContext } from "./turn-execution-state.js";
export async function executeRegularTurn(
  this: AgentRuntimeInternal,
  context: RegularTurnExecutionContext,
): Promise<TurnResult> {
  const {
    input,
    options,
    admittedOutputStyle,
    turnId,
    displayInput,
    turnTraceContext,
    traceId,
    turnStartedAtMs,
    targetRunInputID,
    events,
    turnAbortSignal,
    startTurnPhase,
    completeTurnPhase,
    state,
    activeTurn,
    userMessageId,
  } = context;
  const { admittedModel, submissionModel, turnMemoryRecall } = context;
  let phaseStartedAt: number;
  this.messageHistory.setCacheMiss();
  const loopModel = submissionModel ?? admittedModel;
  if (!loopModel) {
    throw new Error("Turn model was not created before execution");
  }
  state.loopState = {
    activeTurn: activeTurn,
    ...(options?.automationId ? { automationId: options.automationId } : {}),
    // 闲时派发轮的身份进入 loop state，供工具执行边界 deny OffPeakCreate。
    ...(options?.offPeakTaskId ? { offPeakTaskId: options.offPeakTaskId } : {}),
    anomalyWarningsInjected: 0,
    backgroundSubagentResultConsumed: options?.backgroundSubagentResultConsumed === true,
    workflowResultConsumed: options?.workflowResultConsumed === true,
    completedRealToolResultBatch: false,
    currentUserMessageId: userMessageId,
    events,
    input,
    ...(options?.inputId ? { inputId: options.inputId } : {}),
    modelResponse: "",
    model: loopModel,
    ...(options?.modelExecution?.selectionScope === "execution"
      ? { modelSelectionScope: "execution" as const }
      : {}),
    // 加速卡在工具执行期间过期时，本轮不整体失败，改为退回 Session Selection 跑完。
    ...(options?.modelExecution?.selectionFallback
      ? { selectionFallback: options.modelExecution.selectionFallback }
      : {}),
    ...(options?.modelExecution?.subagents && options.intent?.modelSelection
      ? {
          subagentModelOverride: {
            selection: options.intent.modelSelection,
            requestDependencies: options.modelExecution.requestDependencies,
            background: options.modelExecution.subagents.background,
          },
        }
      : {}),
    modelStepCount: 0,
    historyRoundCount: 0,
    // 回合起点已注入的主题与候选路径交给 loop，供回合内的后续请求去重与复用（GAP-01）。
    ...(turnMemoryRecall
      ? {
          recalledMemoryTopics: [...turnMemoryRecall.topics],
          memoryCandidatePaths: [...turnMemoryRecall.discoveredPaths],
        }
      : {}),
    reactiveCompactAttemptedInCurrentModelStep: false,
    repeatedToolCallSignature: undefined,
    repeatedToolCallStreakCount: 0,
    stopHookContinuationCount: 0,
    streamRecoveryRetryCount: 0,
    tokenCount: 0,
    toolCallCount: 0,
    turnRequestState: {
      // Turn 只借一次 canonical 成员集合，之后由显式 commit 推进；entry 本身
      // 遵循 MessageHistory 的不可变约定。
      entries: [...this.messageHistory.borrowReadOnlyRuntimeEntries()],
      outputTokenContinuationCount: 0,
    },
    toolDisallowlist: options?.toolDisallowlist,
    traceId,
    turnAbortSignal,
    turnId,
    turnMachine: state.turnMachine,
    turnOutputStyle: admittedOutputStyle,
    turnTraceContext,
    userMessageId: userMessageId,
  };

  openGoalStateChangeReminderDeferral(activeTurn);
  phaseStartedAt = startTurnPhase("regular_turn_loop");
  try {
    await runRegularTurnLoop.call(this, state.loopState);
    completeTurnPhase("regular_turn_loop", phaseStartedAt);
  } finally {
    finishOutputTokenRecovery(state.loopState.turnRequestState);
    await closeGoalStateChangeReminderDeferral.call(this, activeTurn, turnTraceContext);
  }
  state.turnMachine = state.loopState.turnMachine;

  const turnUsage = createModelUsageSummaryFromEvents(events);
  // goal usage/active-run 先结算，再固定 exact goal/verifier boundary；只有两者都
  // 已持久化，TurnComplete 才能让 projection/UI 开放最终 assistant fork。
  await this.accountTargetTurnCompletion({
    inputID: targetRunInputID,
    startedAtMs: turnStartedAtMs,
    startedTarget: state.startedTarget,
    traceContext: turnTraceContext,
    usage: turnUsage,
  });
  if (
    state.loopState.stableProductStartMessageId &&
    state.loopState.stableBoundaryAssistantMessageId
  ) {
    await persistStableForkCompletionBoundary(this, {
      boundaryMessageId: state.loopState.stableBoundaryAssistantMessageId,
      startMessageId: state.loopState.stableProductStartMessageId,
      historyRoundCount: state.loopState.historyRoundCount,
      traceContext: turnTraceContext,
    });
  }
  if (state.loopState.stableBoundaryAssistantMessageId) {
    await appendBrowserTurnScreenshot(
      this,
      state.loopState,
      state.loopState.stableBoundaryAssistantMessageId,
    );
  }
  const completeEvent = this.createEvent(
    SessionEventType.TurnComplete,
    {
      response: state.loopState.modelResponse,
      tokenCount: state.loopState.tokenCount,
      usage: turnUsage,
      toolCallCount: state.loopState.toolCallCount,
      historyRoundCount: state.loopState.historyRoundCount,
      duration: Date.now() - state.turnMachine.state.startedAt.getTime(),
      resultType: "success",
      ...(state.loopState.backgroundSubagentResultConsumed
        ? { backgroundSubagentResultConsumed: true }
        : {}),
      ...(state.loopState.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
      cacheStats: this.messageHistory.getCacheStats(),
      inputId: options?.inputId,
    },
    turnTraceContext,
  );
  await this.appendEvent(completeEvent, turnTraceContext);
  events.push(completeEvent);
  await recordTurnUsageFact(this, {
    completedAt: Date.now(),
    events,
    startedAt: turnStartedAtMs,
    status: "completed",
    traceContext: turnTraceContext,
    turnId,
    userMessageId: userMessageId,
  });
  if (state.shouldRetryTitleGenerationAfterTurn && userMessageId) {
    // 需要请求前刷新 provider runtime headers 的模型
    // 若在主 turn 前生成标题，会先占用鉴权刷新窗口，导致真正的用户消息失败。
    maybeStartDeferredSessionTitleGeneration.call(
      this,
      displayInput,
      userMessageId,
      turnTraceContext,
    );
  }
  this.turnNumber++;
  if (
    !options?.skipSuggestedPrompt &&
    !options?.inputSource &&
    !options?.targetId &&
    !state.startedTarget &&
    !state.loopState.automationId &&
    !state.loopState.offPeakTaskId &&
    !state.loopState.backgroundSubagentResultConsumed &&
    !state.loopState.workflowResultConsumed
  ) {
    completeSuggestedPromptTurn(this, turnId);
  }

  const projection = await this.rebuildProjection();
  this.logger?.info("Turn completed", {
    ...traceContextToLogContext(turnTraceContext),
    durationMs: Date.now() - state.turnMachine.state.startedAt.getTime(),
    event: "turn.completed",
    module: "core.runtime",
    status: "completed",
    toolCallCount: state.loopState.toolCallCount,
  });
  // 单轮执行策略只抑制本次成功 Turn 的后台提取，不修改 Session Memory 配置。
  if (options?.modelExecution?.memoryExtraction !== "skip") {
    scheduleProjectMemoryExtraction(this, {
      model: state.loopState.model,
      traceContext: turnTraceContext,
    });
  }
  if (this.config.memory?.reviewEnabled === true) {
    void runProjectMemoryReview(this, {
      model: state.loopState.model,
      traceContext: turnTraceContext,
      trigger: "automatic",
    }).catch((error) => {
      this.logger?.warn("Project memory review failed before settlement", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  const result: TurnResult = {
    response: state.loopState.modelResponse,
    turnId,
    traceId,
    usage: turnUsage,
    events,
    projection,
  };
  return result;
}
