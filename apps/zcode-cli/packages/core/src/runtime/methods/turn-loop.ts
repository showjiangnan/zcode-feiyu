// Modified by ZCode Feiyu contributors (2026).
import { beginLocalTurnPreparation } from "@zcode/contracts";
import {
  CompactPhase,
  CompactReason,
  createMessageId,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import {
  buildRuntimeModeReminderBody,
  buildPlanModeExitReminderBody,
  buildRuntimeOutputStyleReminderBody,
  buildTodoReminderBody,
  buildRuntimeProviderRequestMessages,
  createCompactRapidRefillError,
  throwIfTurnAborted,
  shouldBuildTodoReminder,
} from "../helpers/index.js";
import {
  systemReminderAttachmentEntry,
  todoReminderRuntimeMetadata,
} from "../../agent/message-history.js";
import {
  MID_TURN_RECALL_MAX_SELECTED,
  MID_TURN_RECALL_MAX_TOPIC_CHARS,
  MID_TURN_RECALL_MAX_TOTAL_CHARS,
  recallProjectMemoryTopicSet,
} from "../../memory/recall/relevant.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { dropRevokedMemoryFromTurnPrefix } from "./context-refresh.js";
import { runModelBackedTurnStep } from "./turn-model-step.js";
import { activateRuntimeOrchestrationMode } from "../orchestration.js";
import {
  orchestrationReminderBody,
  selectOrchestrationParentTools,
} from "../orchestration-tools.js";
import {
  AUTOMATION_MUTATION_TOOL_NAMES,
  evaluateRapidRefill,
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  OFF_PEAK_MUTATION_TOOL_NAMES,
  RAPID_REFILL_TOOL_TURN_THRESHOLD,
  recordCompactHistoryRound,
  recordCompactSuccess,
} from "./turn-loop-state.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import {
  appendTurnRequestEntries,
  commitTurnRequestEntries,
  filterOutputTokenContinuationEntries,
} from "./turn-output-token-continuation.js";

export async function runRegularTurnLoop(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<void> {
  while (true) {
    throwIfTurnAborted(state.turnAbortSignal);
    const outputTokenRecoveryActive = state.turnRequestState.outputTokenContinuationCount > 0;
    // guide 只允许由完整 tool result batch 设置这个一次性诊断；普通 queue 不在
    // model roundtrip 起点消费，避免把未来 turn 错并入当前 product turn。
    const drainedSteerForNextRequest = state.drainedSteerForNextRequest;
    state.drainedSteerForNextRequest = undefined;

    if (state.modelStepCount > 0 && !outputTokenRecoveryActive) {
      const drainedRuntimeCommands = await this.drainPendingRuntimeCommandsForActiveLoop();
      state.backgroundSubagentResultConsumed ||=
        drainedRuntimeCommands.backgroundSubagentResultConsumed;
      state.workflowResultConsumed ||= drainedRuntimeCommands.workflowResultConsumed;
      appendTurnRequestEntries(state.turnRequestState, drainedRuntimeCommands.runtimeEntries);
      if (drainedRuntimeCommands.drained > 0) {
        state.repeatedToolCallSignature = undefined;
        state.repeatedToolCallStreakCount = 0;
      }
      // 回合起点的召回只覆盖当时的任务陈述；工具往返之后出现的相关主题要在这里补上（复审 GAP-01）。
      // 单个请求只注入一个尚未展示过的主题，正文直接并进请求条目而不重建前缀，保持提示缓存命中。
      const recalled = await recallMemoryForModelStep.call(this, state);
      if (recalled)
        appendTurnRequestEntries(state.turnRequestState, [
          systemReminderAttachmentEntry("memory_recall", recalled),
        ]);
    }

    // 压缩也会调用模型，必须在进入压缩前清除已撤销的受控记忆，避免把旧附件带入摘要请求。
    const beforeCompact = dropRevokedMemoryFromTurnPrefix(
      this,
      state.turnRequestState.entries,
      state.model,
    );
    if (beforeCompact) state.turnRequestState.entries = beforeCompact;
    const compactPhase =
      state.modelStepCount === 0 ? CompactPhase.PreRequest : CompactPhase.MidTurn;
    await this.microcompactIfNeeded(state.turnTraceContext, state.events, state.turnAbortSignal, {
      model: state.model,
      modelStepIndex: state.modelStepCount,
      phase: compactPhase,
      turnRequestState: state.turnRequestState,
    });
    throwIfTurnAborted(state.turnAbortSignal);

    const rapidRefill = evaluateRapidRefill(state.compactTracking);
    const autoCompactOutcome = await this.autoCompactIfNeeded(
      state.turnTraceContext,
      state.events,
      state.turnAbortSignal,
      {
        compactReason: CompactReason.ContextLimit,
        modelStepIndex: state.modelStepCount,
        phase: compactPhase,
        rapidRefill,
        model: state.model,
        turnRequestState: state.turnRequestState,
      },
    );
    if (autoCompactOutcome === "rapid_refill_blocked") {
      throw createCompactRapidRefillError({
        consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
        maxConsecutiveRapidRefills: MAX_CONSECUTIVE_RAPID_REFILLS,
        toolTurnThreshold: RAPID_REFILL_TOOL_TURN_THRESHOLD,
        toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
      });
    }
    if (autoCompactOutcome === "compacted") {
      recordCompactSuccess(state, rapidRefill);
      recordCompactHistoryRound(state);
    }
    throwIfTurnAborted(state.turnAbortSignal);
    const orchestration = outputTokenRecoveryActive
      ? this.orchestration
      : await activateRuntimeOrchestrationMode(this, state.turnTraceContext);

    const finishMcp = beginLocalTurnPreparation(state.turnTraceContext, "mcp");
    await this.initializeMcp(state.turnTraceContext);
    finishMcp();
    throwIfTurnAborted(state.turnAbortSignal);
    const finishTools = beginLocalTurnPreparation(state.turnTraceContext, "tools");
    const turnDisallowedTools = buildTurnDisallowedTools(state);
    // automation 派发到已 active 会话或重试恢复时，入口 metadata 可能没有带到
    // loop state；但 queryId 仍是 automation-*。provider 请求边界必须按 queryId 再硬过滤
    // automation 写工具，否则模型会先看到并创建、修改或删除任务定义。
    const availableTools = state.automationCreateLimitReached
      ? []
      : turnDisallowedTools
        ? this.getTools(state.model).filter((tool) => !turnDisallowedTools.has(tool.name))
        : this.getTools(state.model);
    const tools = selectOrchestrationParentTools(
      availableTools,
      orchestration.effective,
      Boolean(this.config.parentSessionId && this.teamBoardPort),
    );
    finishTools();
    if (!outputTokenRecoveryActive && this.needsPlanModeExitReminder) {
      this.needsPlanModeExitReminder = false;
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("plan_mode_exit", buildPlanModeExitReminderBody()),
      ]);
    }
    const runtimeModeReminderBody = outputTokenRecoveryActive
      ? null
      : buildRuntimeModeReminderBody(
          state.turnRequestState.entries,
          this.getMode(),
          this.getPlanEnabled(),
        );
    if (runtimeModeReminderBody) {
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("runtime_mode", runtimeModeReminderBody),
      ]);
    }
    const orchestrationReminder = outputTokenRecoveryActive
      ? null
      : orchestrationReminderBody(orchestration.effective);
    if (orchestrationReminder) {
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("orchestration_mode", orchestrationReminder),
      ]);
    }
    if (
      !outputTokenRecoveryActive &&
      tools.some((tool) => tool.name === "TodoWrite") &&
      shouldBuildTodoReminder(state.turnRequestState.entries)
    ) {
      const currentTodos = await this.readSessionTodosForContext(state.turnTraceContext);
      const reminderBody = buildTodoReminderBody(currentTodos);
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("todo_reminder", reminderBody),
      ]);
      await this.persistSyntheticUserNoticeForSession({
        messageID: createMessageId(),
        metadata: { runtimeMessage: todoReminderRuntimeMetadata() },
        sessionId: this.sessionId,
        source: "todo_reminder",
        text: reminderBody,
        traceContext: state.turnTraceContext,
      });
    }
    const outputStyleReminderBody =
      state.modelStepCount === 0
        ? buildRuntimeOutputStyleReminderBody(state.turnOutputStyle)
        : null;
    if (outputStyleReminderBody) {
      // output_style 是 provider-visible 的当前 turn runtime attachment，
      // 需要进入内存历史参与后续 request 的增量轨迹；但不把它落 session。
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("output_style", outputStyleReminderBody),
      ]);
    }
    // 记忆许可可能在回合进行中被关闭并已确认；确认之后的新请求不得继续携带旧记忆（复审 DEF-04）。
    const memoryFreeEntries = dropRevokedMemoryFromTurnPrefix(
      this,
      state.turnRequestState.entries,
      state.model,
    );
    if (memoryFreeEntries) state.turnRequestState.entries = memoryFreeEntries;
    const providerEntries = [...state.turnRequestState.entries];
    const requestEntries = providerEntries;
    // provider-visible user ordering projection 会改变最终 latest user 落点，
    // cache-control 必须在 projection 后统一设置，避免 raw synthetic entry 抢占缓存锚点。
    const providerProjection = buildRuntimeProviderRequestMessages(this, {
      entries: requestEntries,
      applyCacheControl: true,
      model: state.model,
    });
    const { messages } = providerProjection;
    const recordableEntries = filterOutputTokenContinuationEntries(requestEntries);
    const recordableProjection =
      recordableEntries === requestEntries
        ? providerProjection
        : buildRuntimeProviderRequestMessages(this, {
            entries: recordableEntries,
            applyCacheControl: true,
            model: state.model,
          });
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.startModelRequest(
        `${state.model.providerId}/${state.model.modelId}`,
        recordableProjection.messages,
      ),
    );

    // 生产包需要知道 Turn 是否已经跨过 provider 边界；这里只记录请求元数据，
    // 不记录 prompt、消息内容或 streaming chunk，避免泄露内容并控制日志量。
    this.logger?.info("Model request started", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "model.request.started",
      module: "core.runtime",
      status: "started",
      messageCount: messages.length,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
    });

    const result = await runModelBackedTurnStep.call(this, state, {
      drainedSteerForNextRequest,
      latestRealUserMessageIndex: providerProjection.diagnostics.latestRealUserMessageIndex,
      messages,
      sourceEntries: providerProjection.sourceEntries,
      requestEntries,
      recordedMessages: recordableProjection.messages,
      tools,
    });

    if (result === "break") {
      break;
    }
  }
}

/**
 * 回合内每个新模型请求的召回：以原始需求加最近的工具活动为查询，检索尚未展示过的主题。
 *
 * 修复原因（复审 GAP-01）：召回只在回合起点做过一次，后续请求直接复用那次结果，
 * 模型在工具往返后看不到新出现的相关主题。依据：CONT-FR-04 要求相关记忆随工作推进保持可用；
 * 这里把新主题作为追加条目注入，不重建上下文前缀，因此提示缓存前缀不受影响。
 * 上限比回合起点更克制（1 条、1,200 字符），避免每次模型往返都灌入大段记忆。
 */
async function recallMemoryForModelStep(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<string | undefined> {
  const memoryRoot = this.memoryRoot;
  const fileSystem = this.fileSystemPort;
  if (!memoryRoot || !fileSystem) return undefined;
  let query: string;
  try {
    query = memoryStepRecallQuery(state);
  } catch {
    return undefined;
  }
  if (!query) return undefined;
  try {
    const recalled = await recallProjectMemoryTopicSet({
      fileSystem,
      query,
      rootDir: memoryRoot,
      signal: state.turnAbortSignal,
      discoveredPaths: state.memoryCandidatePaths,
      exclude: new Set(state.recalledMemoryTopics ?? []),
      maxSelected: MID_TURN_RECALL_MAX_SELECTED,
      maxTopicChars: MID_TURN_RECALL_MAX_TOPIC_CHARS,
      maxTotalChars: MID_TURN_RECALL_MAX_TOTAL_CHARS,
    });
    state.memoryCandidatePaths = recalled.discoveredPaths;
    if (!recalled.content) return undefined;
    state.recalledMemoryTopics = [...(state.recalledMemoryTopics ?? []), ...recalled.topics];
    return recalled.content;
  } catch {
    // 记忆检索失败不得阻断当前用户轮次；下一次模型步骤会再试。
    return undefined;
  }
}

/** 查询词取「原始需求 + 最近 8 条工具调用的名称与入参」，只用于打分，不进入请求。 */
function memoryStepRecallQuery(state: RegularTurnLoopState): string {
  const recent: string[] = [];
  for (let index = state.turnRequestState.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.turnRequestState.entries[index];
    if (!entry || entry.kind === "attachment") continue;
    const toolCalls = entry.message.toolCalls;
    if (!toolCalls) continue;
    for (const toolCall of toolCalls) {
      recent.push(`${toolCall.name} ${safeStringify(toolCall.input)}`);
      if (recent.length >= 8) break;
    }
    if (recent.length >= 8) break;
  }
  return [state.input, ...recent].filter(Boolean).join("\n").slice(0, 8_000);
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  } catch {
    return "";
  }
}

function buildTurnDisallowedTools(state: RegularTurnLoopState): Set<string> | null {
  const tools = new Set(state.toolDisallowlist ?? []);
  if (isAutomationMutationRestrictedTurn(state)) {
    // 定时任务执行轮只应运行任务 prompt，不能反过来管理自己的定义。
    // 保留 CronList 供只读查询；所有 mutation 在 provider 请求边界统一隐藏。
    for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  if (isOffPeakCreateRestrictedTurn(state)) {
    // 闲时执行轮禁止再创建闲时任务（防递归自我派生）；OffPeakList 只读保留。
    // 注意 automation 执行轮不进此分支——cron turn 放行 OffPeakCreate。
    for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  return tools.size > 0 ? tools : null;
}
