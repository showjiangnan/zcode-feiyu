// Modified by ZCode Feiyu.
import { beginLocalTurnPreparation } from "@zcode/contracts";
import { isProactiveCommandId } from "../orchestration.js";

import { ensureGroupTaskPermissionScope } from "./input-intent-persistence.js";
import {
  HookEventName,
  SessionEventType,
  createMessageId,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import {
  throwIfTurnAborted,
  createTurnFailureError,
  appendTurnOutcomeEvent,
  summarizeTurnAttachmentsForEvent,
} from "../helpers/index.js";
import type { TurnResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

import {
  applySubmissionExecutionState,
  createTurnModel,
  resolveExecutionModelRetryBudget,
} from "./turn-model.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { recallProjectMemoryTopicSet } from "../../memory/recall/relevant.js";
import type { TurnExecutionContext } from "./turn-execution-state.js";
import { prepareTurnInput } from "./turn-input-preparation.js";
import { executeRegularTurn } from "./turn-regular-execution.js";
import { handleTurnExecutionFailure } from "./turn-execution-failure.js";
import { commandIdForImage } from "./turn-input-reminders.js";
const TARGET_RUN_HEARTBEAT_MS = 15_000;
export async function runAdmittedTurnExecution(
  this: AgentRuntimeInternal,
  context: TurnExecutionContext,
): Promise<TurnResult> {
  const {
    input,
    attachments,
    options,
    admittedModelSelection,
    compactInstructions,
    rewindCommand,
    turnId,
    queryId,
    displayInput,
    turnTraceContext,
    turnStartedAtMs,
    targetRunInputID,
    events,
    turnAbortSignal,
    startTurnPhase,
    completeTurnPhase,
    state,
  } = context;

  const executionStartedAt = performance.timeOrigin + performance.now();
  beginLocalTurnPreparation(turnTraceContext, "execution")();
  throwIfTurnAborted(turnAbortSignal);
  let admittedModel;
  try {
    admittedModel =
      rewindCommand === null
        ? createTurnModel(this, {
            requestDependencies: options?.modelExecution?.requestDependencies,
            selection: admittedModelSelection,
            // 带退回声明的执行句柄 0 次重试：失败立刻交给 turn step 退回会话模型。
            retryBudget: resolveExecutionModelRetryBudget({
              selection: admittedModelSelection,
              selectionFallback: options?.modelExecution?.selectionFallback,
            }),
          })
        : undefined;
  } catch (error) {
    // 同步滞后/模型失效可在内层 Turn try 之前创建失败。只写日志会让已接纳输入
    // 没有终态、桌面与手机都看不到错误；复用 outcome，不等待同步、不改原选择。
    state.turnFailureHandled = true;
    const coreError = createTurnFailureError(error, turnAbortSignal, "Model creation failed");
    await appendTurnOutcomeEvent(this, {
      coreError,
      events,
      durationMs: Date.now() - turnStartedAtMs,
      turnPhase: "model_creation",
      inputId: options?.inputId,
      traceContext: turnTraceContext,
      fallbackMessage: "Model creation failed",
      logEvent: "turn.failed",
      logLabel: "Turn",
    });
    throw coreError;
  }
  let phaseStartedAt = startTurnPhase("context_initialization");
  const contextWasInitialized = this.contextInitialized;
  if (!contextWasInitialized) {
    // 首轮初始化已经用 admitted Model 构造并安装完整 Context，随后再 rebuild
    // 会把同一 Prefix 连续构造两次。未初始化与已初始化分支互斥，每个 model step 只构造一次。
    await this.ensureContextInitialized(turnTraceContext, admittedModel);
  }
  const turnMemoryRecall =
    this.memoryRoot && this.fileSystemPort
      ? await recallProjectMemoryTopicSet({
          fileSystem: this.fileSystemPort,
          query: input,
          rootDir: this.memoryRoot,
          signal: turnAbortSignal,
        })
      : undefined;
  const memoryRelevantContent = turnMemoryRecall?.content ?? "";
  if (contextWasInitialized || memoryRelevantContent) {
    // 每轮只向当前请求注入相关主题；下一轮重新检索，避免旧主题常驻上下文。
    rebuildContextPrefix(this, { memoryRelevantContent, model: admittedModel });
  }
  completeTurnPhase("context_initialization", phaseStartedAt);
  throwIfTurnAborted(turnAbortSignal);
  phaseStartedAt = startTurnPhase("session_start_hooks");
  const sessionStartHookResult = await this.runSessionStartHooks(
    "startup",
    turnTraceContext,
    turnAbortSignal,
    admittedModel,
  );
  completeTurnPhase("session_start_hooks", phaseStartedAt);
  this.injectHookAdditionalContextIntoMessageHistory(
    HookEventName.SessionStart,
    sessionStartHookResult.additionalContexts,
  );

  if (compactInstructions !== null) {
    const compactModel = await applySubmissionExecutionState(
      this,
      options?.intent,
      turnTraceContext,
      options?.modelExecution,
      admittedModel,
    );
    return this.executeManualCompact(
      input,
      compactInstructions,
      turnId,
      turnTraceContext,
      turnAbortSignal,
      options?.inputId,
      compactModel,
    );
  }
  if (rewindCommand !== null) {
    return this.executeRewindCommand(
      input,
      rewindCommand,
      turnId,
      turnTraceContext,
      turnAbortSignal,
      options?.inputId,
    );
  }
  state.activeTurn = this.beginActiveTurn(
    turnId,
    turnTraceContext,
    "regular",
    true,
    options?.inputId === undefined ? {} : { inputId: options.inputId },
  );
  // 前台输入绑定一次付费许可；内部续跑和主动触发不得制造新许可。
  this.paidImageInputId =
    (!options?.inputSource ||
      (options.inputSource === "subagent" &&
        String(this.config.taskType).endsWith("_child") &&
        this.config.imageGeneration?.enabled === true &&
        this.config.imageGeneration.allowSubagents === true)) &&
    options?.inputVisibility !== "model-only" &&
    !options?.skipInputRecord &&
    !isProactiveCommandId(commandIdForImage(options)) &&
    !options?.automationId &&
    !options?.offPeakTaskId
      ? (options?.intent?.sourceCommandId ?? options?.inputId ?? turnId)
      : undefined;
  this.logger?.info("Turn started", {
    ...traceContextToLogContext(turnTraceContext),
    event: "turn.started",
    inputLength: input.length,
    module: "core.runtime",
    status: "started",
  });

  state.turnMachine = new TurnMachineImpl(state.turnMachine.start());
  phaseStartedAt = startTurnPhase("session_persistence");
  await this.ensureSessionPersisted(displayInput, turnTraceContext);
  await ensureGroupTaskPermissionScope(this.sessionStore, this.sessionId, options?.intent);
  // execution-scoped 临时 Provider（例如闲时任务）拥有本轮自己的模型，不改写
  // Session Selection；普通 Submission 才在真正开跑时应用其原子选择。
  const submissionModel = await applySubmissionExecutionState(
    this,
    options?.intent,
    turnTraceContext,
    options?.modelExecution,
    admittedModel,
  );
  state.startedTarget = await this.readSessionTargetForContext(turnTraceContext);
  completeTurnPhase("target_read", phaseStartedAt);
  if (state.startedTarget?.status !== "active") {
    state.startedTarget = null;
  }
  state.userMessageId =
    options?.skipInputRecord === true
      ? (options.recordedInputMessageId ?? createMessageId())
      : createMessageId();
  // 附件展示元信息随 TurnStarted 下发（v4 投影 → userInput row.attachments）。
  // workspace checkpoint 挂在 user messageId 上；先生成 id 再发 TurnStarted，
  // v4 投影才能用 turn rowId 找回该轮文件 checkpoint，避免摘要有计数但展开查空。
  const attachmentMetas = summarizeTurnAttachmentsForEvent(attachments);
  const turnStartedEvent = this.createEvent(
    SessionEventType.TurnStarted,
    {
      executionStartedAt,
      turnNumber: this.turnNumber,
      input: displayInput,
      messageId: state.userMessageId,
      inputId: options?.inputId,
      ...(options?.automationId
        ? { automationId: options.automationId }
        : options?.offPeakTaskId
          ? {
              offPeakTaskId: options.offPeakTaskId,
              ...(options.offPeakRunType ? { offPeakRunType: options.offPeakRunType } : {}),
            }
          : {}),
      foregroundExecutionId: this.activeForegroundExecution?.foregroundExecutionId,
      queryId,
      inputSource: options?.inputSource,
      inputVisibility: options?.inputVisibility,
      originMeta: options?.originMeta,
      ...(options?.epilogueStart === undefined ? {} : { epilogueStart: options.epilogueStart }),
      ...(options?.backgroundSource ? { backgroundSource: options.backgroundSource } : {}),
      targetId: options?.targetId,
      ...(options?.intent ? { intent: options.intent } : {}),
      ...(attachmentMetas ? { attachments: attachmentMetas } : {}),
    },
    turnTraceContext,
  );
  phaseStartedAt = startTurnPhase("turn_started_event");
  await this.appendEvent(turnStartedEvent, turnTraceContext);
  completeTurnPhase("turn_started_event", phaseStartedAt);
  events.push(turnStartedEvent);
  phaseStartedAt = startTurnPhase("target_accounting");
  state.startedTarget = await this.startTargetTurnAccounting({
    inputID: targetRunInputID,
    startedAtMs: turnStartedAtMs,
    startedTarget: state.startedTarget,
    traceContext: turnTraceContext,
  });
  completeTurnPhase("target_accounting", phaseStartedAt);
  if (state.startedTarget && this.sessionStore?.heartbeatTargetRun) {
    state.targetRunHeartbeat = setInterval(() => {
      void this.trackResidencyBlockingWork(
        this.heartbeatTargetTurnAccounting({
          inputID: targetRunInputID,
          seenAtMs: Date.now(),
          startedTarget: state.startedTarget,
          traceContext: turnTraceContext,
        }),
      );
    }, TARGET_RUN_HEARTBEAT_MS);
    if (typeof state.targetRunHeartbeat === "object" && "unref" in state.targetRunHeartbeat) {
      state.targetRunHeartbeat.unref();
    }
  }

  try {
    const activeContext = {
      ...context,
      activeTurn: state.activeTurn,
      userMessageId: state.userMessageId,
    };
    const blockedResult = await prepareTurnInput.call(this, activeContext);
    if (blockedResult) return blockedResult;
    return await executeRegularTurn.call(this, {
      ...activeContext,
      admittedModel,
      submissionModel,
      turnMemoryRecall,
    });
  } catch (error) {
    return handleTurnExecutionFailure.call(this, context, error);
  }
}
