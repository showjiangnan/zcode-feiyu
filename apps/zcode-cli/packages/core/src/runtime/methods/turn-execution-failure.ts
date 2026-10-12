// Modified by ZCode Feiyu.
import { CoreErrorType } from "../deps.js";
import { createTurnFailureError, appendTurnOutcomeEvent } from "../helpers/index.js";

import type { AgentRuntimeInternal } from "../internal.js";

import { recordTurnUsageFact } from "./usage-observability.js";

import type { TurnExecutionContext } from "./turn-execution-state.js";
export async function handleTurnExecutionFailure(
  this: AgentRuntimeInternal,
  context: TurnExecutionContext,
  error: unknown,
): Promise<never> {
  const {
    options,
    turnId,
    turnTraceContext,
    turnStartedAtMs,
    targetRunInputID,
    events,
    turnAbortSignal,
    state,
  } = context;

  state.turnFailureHandled = true;
  const coreError = createTurnFailureError(error, turnAbortSignal, "Turn execution failed");
  const preserveQueueAutoDrainOnCancel =
    coreError.type === CoreErrorType.TurnCancelled &&
    this.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
  const finishedTarget = await this.finishTargetTurnAccounting({
    endedAtMs: Date.now(),
    inputID: targetRunInputID,
    startedTarget: state.startedTarget,
    status: coreError.type === CoreErrorType.TurnCancelled ? "paused" : undefined,
    traceContext: turnTraceContext,
  });
  if (finishedTarget?.targetID === state.startedTarget?.targetID) {
    state.startedTarget = finishedTarget;
  }
  if (coreError.type === CoreErrorType.TurnCancelled) {
    await this.pauseActiveTargetForCancellation(turnTraceContext);
    if (state.activeTurn) {
      await this.fallbackPendingGuidesToQueue({
        activeTurn: state.activeTurn,
        events,
        reasonCode: "guide.turnInterrupted",
        traceContext: turnTraceContext,
      });
    }
  }
  // 普通 TurnError 只结束当前 turn，不撤销已经 accepted 的 future input。
  // V4 TurnError 投影将队列切成 error-paused，runtime 同步关闭行内 drain，
  // 保留排队输入，等待用户显式继续。
  if (state.activeTurn && coreError.type !== CoreErrorType.TurnCancelled) {
    const pendingInputs = (await this.rebuildProjection()).pendingSteerInputs;
    if (pendingInputs.length > 0) {
      this.queueAutoDrain = false;
      this.queueExternalDrainActive = false;
    }
  } else if (
    state.activeTurn &&
    coreError.type === CoreErrorType.TurnCancelled &&
    !preserveQueueAutoDrainOnCancel &&
    state.activeTurn.pendingInputs.length > 0
  ) {
    // runtime 授权位与投影同步：投影在 TurnComplete(cancelled)+queue>0 时把
    // queue.autoDrain 置 false（held），runtime 的 drain 门也必须同步翻转，
    // 否则 held 期间新起的 turn 会把后续入队项 drain 掉，与投影语义分叉。
    this.queueAutoDrain = false;
    this.queueExternalDrainActive = false;
  }

  // background wake 可能在 loopState 初始化前取消；此时仍要保留已 dequeue 的结果事实。
  const backgroundSubagentResultConsumed =
    options?.backgroundSubagentResultConsumed === true ||
    state.loopState?.backgroundSubagentResultConsumed === true;
  const workflowResultConsumed =
    options?.workflowResultConsumed === true || state.loopState?.workflowResultConsumed === true;
  await appendTurnOutcomeEvent(this, {
    coreError,
    events,
    durationMs: Date.now() - state.turnMachine.state.startedAt.getTime(),
    turnPhase: state.turnMachine.state.phase,
    inputId: options?.inputId,
    traceContext: turnTraceContext,
    fallbackMessage: "Turn execution failed",
    logEvent: "turn.failed",
    logLabel: "Turn",
    preserveQueueAutoDrainOnCancel,
    backgroundSubagentResultConsumed,
    workflowResultConsumed,
    historyRoundCount: state.loopState?.historyRoundCount,
  });
  await recordTurnUsageFact(this, {
    completedAt: Date.now(),
    error: coreError,
    events,
    startedAt: turnStartedAtMs,
    status: coreError.type === CoreErrorType.TurnCancelled ? "cancelled" : "error",
    traceContext: turnTraceContext,
    turnId,
    userMessageId: state.userMessageId,
  });
  throw coreError;
}
