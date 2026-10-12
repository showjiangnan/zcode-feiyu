// Modified by ZCode Feiyu.
import { runWithModelExecutionScope, beginLocalTurnPreparation, type LocalTtftDetail } from "@zcode/contracts";

import {
  createChildTraceContext,
  createQueryId,
  createTurnId,
  runWithContextAsync,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import type { QueryId, SessionEvent, TurnState } from "../deps.js";
import {
  parseCompactCommand,
  parseRewindCommand,
  createTurnAbortScope,
  isTurnCancellationError,
} from "../helpers/index.js";
import type { ExecuteTurnOptions, TurnResult } from "../types.js";
import type { ActiveTurnStartReservation } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

import { clearBrowserTurnState } from "../../repl/browser-turn-state.js";

import { runAdmittedTurnExecution } from "./turn-execution.js";
import type { TurnExecutionContext, TurnExecutionState } from "./turn-execution-state.js";
export async function executeTurnCommandOwned(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
  startReservation?: ActiveTurnStartReservation,
): Promise<TurnResult> {
  // 普通 Turn 过去在异步初始化完成后才读取 Session Selection/输出样式，
  // 初始化期间发生的切模会越过 admission 边界，错误影响已经开始的 Turn。
  // 这里在任何 await 之前冻结本轮事实；后续配置变化只作用于下一轮。
  const admittedModelSelection = options?.intent?.modelSelection ?? this.getSessionModelSelection();
  const admittedOutputStyle = this.config.outputStyle;
  const compactInstructions = parseCompactCommand(input);
  const rewindCommand = parseRewindCommand(input);
  const turnId = startReservation?.turnId ?? createTurnId();
  const queryId = options?.queryId ?? (options?.inputId as QueryId | undefined) ?? createQueryId();
  const displayInput = options?.displayInput ?? input;
  const turnTraceContext =
    startReservation?.traceContext ??
    createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
      queryId,
      sessionId: this.sessionId,
      turnId,
      attributes: {
        turnNumber: this.turnNumber,
      },
    });
  const traceId = turnTraceContext.traceId;
  const turnStartedAtMs = Date.now();
  // 排队期间切换订阅连接，已接受输入仍属原授权；鉴权时间必须取Inbox admission事实。
  const admittedAtMs = options?.intent?.admittedAt ?? turnStartedAtMs;
  const modelExecutionStartedAt = Number.isFinite(admittedAtMs) && admittedAtMs <= turnStartedAtMs ? admittedAtMs : turnStartedAtMs;
  const targetRunInputID = options?.inputId ?? String(turnId);
  const events: SessionEvent[] = [];
  const state: TurnExecutionState = {
    turnMachine: TurnMachineImpl.create(this.sessionId, this.turnNumber, input, traceId, turnId),
    startedTarget: null,
    shouldRetryTitleGenerationAfterTurn: false,
    turnPhase: "queued",
    turnFailureHandled: false,
  };
  this.currentTurnFileChanges = new Map();
  if (!startReservation) this.reserveTurnStart(turnId, turnTraceContext, "regular");

  const turnAbortScope = createTurnAbortScope(options?.abortSignal);
  const turnAbortSignal = turnAbortScope.signal;
  let finishPreparation: () => void = () => {};
  const preparationStages: Record<string, LocalTtftDetail["stage"]> = {
    context_initialization: "context",
    session_start_hooks: "hooks",
    user_prompt_hooks: "hooks",
    session_persistence: "persistence",
    turn_started_event: "persistence",
    target_accounting: "persistence",
  };
  const startTurnPhase = (phase: string): number => {
    const stage = preparationStages[phase];
    finishPreparation =
      stage && stage !== "attempt" && stage !== "retry_wait" && stage !== "user_confirmation"
        ? beginLocalTurnPreparation(turnTraceContext, stage)
        : () => {};
    state.turnPhase = phase;
    const startedAt = Date.now();
    this.logger?.info("Turn phase started", {
      ...traceContextToLogContext(turnTraceContext),
      event: "turn.phase.started",
      module: "core.runtime",
      phase,
      status: "started",
    });
    return startedAt;
  };
  const completeTurnPhase = (phase: string, startedAt: number): void => {
    finishPreparation();
    this.logger?.info("Turn phase completed", {
      ...traceContextToLogContext(turnTraceContext),
      durationMs: Date.now() - startedAt,
      event: "turn.phase.completed",
      module: "core.runtime",
      phase,
      status: "completed",
    });
  };
  const turnTelemetry = this.agentTelemetry.turn({
    inputSource: options?.inputSource,
    traceContext: turnTraceContext,
    turnNumber: this.turnNumber,
  });

  const context: TurnExecutionContext = {
    input,
    attachments,
    options,
    admittedModelSelection,
    admittedOutputStyle,
    compactInstructions,
    rewindCommand,
    turnId,
    queryId,
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
  };
  const execute = () =>
    runWithContextAsync(turnTraceContext, async () => {
      return runAdmittedTurnExecution.call(this, context);
    }).then(
      (result) => {
        turnTelemetry.finishCompleted("assistant_message");
        return result;
      },
      (error: unknown) => {
        if (!state.turnFailureHandled) {
          this.logger?.warn("Turn execution escaped lifecycle handler", {
            ...traceContextToLogContext(turnTraceContext),
            durationMs: Date.now() - turnStartedAtMs,
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "turn.lifecycle.unhandled_rejection",
            module: "core.runtime",
            phase: state.turnPhase,
            status: "failed",
          });
        }
        if (isTurnCancellationError(error, turnAbortSignal)) {
          turnTelemetry.finishCancelled("abort_signal");
        } else {
          turnTelemetry.finishFailed("unhandled", "unknown", error);
        }
        throw error;
      },
    );

  return runWithModelExecutionScope(String(turnId), modelExecutionStartedAt, () => turnTelemetry.run(execute)).finally(async () => {
    if (state.targetRunHeartbeat) {
      clearInterval(state.targetRunHeartbeat);
    }
    this.releaseTurnStart(turnId);
    clearBrowserTurnState(this.sessionId, turnId);
    this.finishActiveTurn(state.activeTurn);
    turnAbortScope.dispose();
    try {
      await this.browserControlPort?.turnEnded?.({
        sessionId: this.sessionId,
        turnId: String(turnId),
        traceContext: turnTraceContext,
      });
    } catch (error) {
      // 生命周期清理失败不能覆盖已经完成/失败的主 turn；backend 会在 session close 再兜底释放。
      this.logger?.warn("Browser turn cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "browser.turn_cleanup.failed",
        turnId: String(turnId),
      });
    }
  });
}
