// Modified by ZCode Feiyu.
import { SESSION_ENTRY_EXECUTION_STATE } from "@zcode/contracts";
import { executionStateSchema, resolveExecutionState } from "@zcode/shared";
import type { ToolSchedule, TurnId, TurnState } from "../deps.js";
import {
  activeSessionMessages,
  CoreErrorType,
  createCoreError,
  HookEventName,
  hydrateMessageHistoryFromSession,
  hydrateReadFileStateFromSession,
  MessageHistoryImpl,
  SessionEventType,
  traceContextToLogContext,
} from "../deps.js";
import { getLatestActiveSessionMessageId } from "../helpers/index.js";
import { restorePermissionGrantMarker } from "../helpers/permission-grant-resume.js";
import { repairPersistedRemoteSessionPaths } from "../helpers/persisted-remote-session-path-repair.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { restoreRuntimeOrchestrationMode } from "../orchestration.js";
import { persistTeamMemberEvent, restorePersistedLocalAgents } from "../team-member-state.js";
import type { ResumeSessionOptions, ResumeSessionResult } from "../types.js";
import { restoreDynamicWorkflowActivationOnResume } from "./dynamic-workflow-activation.js";
import {
  announceSessionShellEnvironmentNoticeAfterResume,
  getSessionShellSelection,
  restoreSessionShellEnvironmentSelectionForResume,
} from "./session-shell-environment.js";
import { mainTurnCacheHitAggregateFromMessages } from "./turn-model-step-usage.js";
import {
  restoreWorkspaceCheckpointEntries,
  restoreWorkspaceFileRewindEntries,
} from "./workspace-checkpoint-persistence.js";
import { extractPersistedEnvInfo, syncPersistedSessionTitleForResume } from "./resume-context.js";

export function toScheduleState(
  this: AgentRuntimeInternal,
  schedule: ToolSchedule,
): TurnState["scheduledTools"] {
  return {
    items: schedule.items.map((item) => ({
      toolCallId: item.toolCallId,
      dependencies: item.dependencies,
      canRunParallel: item.canRunParallel,
    })),
    parallelGroups: schedule.parallelGroups,
    executionOrder: schedule.executionOrder,
  };
}

export async function resumeFromStore(
  this: AgentRuntimeInternal,
  options?: ResumeSessionOptions,
): Promise<ResumeSessionResult> {
  if (!this.sessionStore) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Cannot resume session without a session store",
      { recoverable: false },
    );
  }

  const traceContext = options?.traceContext ?? this.rootTraceContext;
  const persistedSession = await this.sessionStore.getSession(this.sessionId);
  if (!persistedSession || persistedSession.time.archived !== undefined) {
    throw createCoreError(CoreErrorType.SessionNotFound, `Session not found: ${this.sessionId}`, {
      context: { sessionId: this.sessionId },
      recoverable: true,
    });
  }
  const session = await repairPersistedRemoteSessionPaths(this.sessionStore, persistedSession, {
    onPersistenceFailure: (error) => {
      this.logger?.warn("Session path repair persistence failed; using in-memory repair", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session.path_repair.persist_failed",
        module: "core.runtime",
        sessionId: this.sessionId,
      });
    },
  });

  const messages =
    options?.persistedMessages ??
    (await this.sessionStore.messages({
      sessionID: this.sessionId,
    }));
  const rewindTargetMessageId = session.revert?.targetMessageID;
  const rewindCreatedMessageId = session.revert?.createdMessageID;
  const rewindKeptMessageIds = session.revert?.keptMessageIDs;
  const branchCutAfterMessageId = session.revert?.branchCutAfterMessageID;
  this.branchGeneration = session.revert?.branchGeneration ?? 0;
  this.runtimeTaskRegistry.setActiveBranchGeneration?.(this.branchGeneration);
  if (messages.length === 0) {
    this.logger?.warn("Session resume loaded zero persisted messages", {
      ...traceContextToLogContext(traceContext),
      directory: session.directory,
      event: "session.resume.persisted_messages_zero",
      module: "core.runtime",
      rewindCreatedMessageId,
      rewindKeptMessageCount: rewindKeptMessageIds?.length ?? 0,
      rewindTargetMessageId,
      sessionId: this.sessionId,
    });
  }
  const persistedEnvInfo = extractPersistedEnvInfo(messages);
  if (persistedEnvInfo) {
    this.config.envInfo = persistedEnvInfo;
  }
  const shellRestore = await restoreSessionShellEnvironmentSelectionForResume(this, {
    currentSelection: getSessionShellSelection(this),
    traceContext,
  });

  this.workingDirectory = session.directory;
  this.config.taskType = session.taskType;
  if (this.config.memory) {
    // Memory root 必须使用会话落盘时的 workspace identity，不能沿用进程启动 workspace。
    this.config.memory.workspaceIdentity = session.workspaceID
      ? String(session.workspaceID)
      : undefined;
  }
  this.messageHistory = new MessageHistoryImpl();
  this.contextBuilder = null;
  this.contextInitialized = false;
  this.lastEmittedLocalDate = undefined;
  // cold resume 的历史 hydration 会先清空 runtime-local read-state；必须在
  // Context 初始化前完成，确保随后单次加载的 MEMORY.md 状态与 provider 所见内容一致。
  const readFileStateHydration = await hydrateReadFileStateFromSession({
    branchCutAfterMessageId,
    messages,
    readFileState: this.readFileState,
    rewindCreatedMessageId,
    rewindKeptMessageIds,
    rewindTargetMessageId,
    workingDirectory: this.workingDirectory,
    workspaceRoot: this.workspaceRoot,
  });
  await this.ensureContextInitialized(traceContext);
  const recoveredCompactTimelineCount = await this.recoverInterruptedCompactTimelines(
    messages,
    traceContext,
  );
  const hydration = await hydrateMessageHistoryFromSession({
    artifactStore: this.artifactStore,
    branchCutAfterMessageId,
    history: this.messageHistory,
    messages,
    rewindCreatedMessageId,
    rewindKeptMessageIds,
    rewindTargetMessageId,
  });
  announceSessionShellEnvironmentNoticeAfterResume(this, {
    persistedEnvInfo,
    restore: shellRestore,
  });
  const activeMessages = activeSessionMessages(messages, {
    branchCutAfterMessageId,
    rewindCreatedMessageId,
    rewindKeptMessageIds,
    rewindTargetMessageId,
  });
  // compact preserved segment 会把 compact 前消息插回 provider 上下文，
  // 但它不是 compact 后时间线的 latest anchor，不能用于后续 compact parentID。
  const timelineActiveMessages = activeSessionMessages(messages, {
    branchCutAfterMessageId,
    includeCompactPreservedSegment: false,
    rewindCreatedMessageId,
    rewindKeptMessageIds,
    rewindTargetMessageId,
  });
  const latestAssistant = [...timelineActiveMessages]
    .reverse()
    .find((message) => message.info.role === "assistant");
  this.latestConversationMessageId = getLatestActiveSessionMessageId(timelineActiveMessages);
  this.latestAssistantMessageId = latestAssistant?.info.id;
  this.latestAssistantTurnId = latestAssistant?.info.anchor?.turnId as TurnId | undefined;
  this.lastAssistantCompletedAtMs =
    latestAssistant && "completed" in latestAssistant.info.time
      ? latestAssistant.info.time.completed
      : undefined;

  await restoreWorkspaceCheckpointEntries(this, traceContext);
  await restoreWorkspaceFileRewindEntries(this, traceContext);
  const restoredEvents = await this.eventStore.getEvents(this.sessionId);
  const restoredModeEvents = restoredEvents.filter(
    (event) =>
      event.type === SessionEventType.SessionCreated ||
      event.type === SessionEventType.SessionModeChanged,
  );
  const restoredMode =
    restoredModeEvents.length > 0 ? this.eventReducer.reduce(restoredModeEvents).mode : undefined;
  const resolvedMode = options?.modeOverride ?? restoredMode ?? session.permission?.mode;
  if (resolvedMode !== undefined) {
    // cold resume 会先把 checkpoint/rewind 等局部事件恢复到新的内存 eventStore。
    // 这些事件不携带 mode，若仅按“存在任意事件”reduce，会用默认 build 覆盖 headless yolo。
    // 只有权威 mode 事件能恢复历史值；本次 invocation 的显式/default mode 仍保持最高优先级。
    Object.assign(this.config, resolveExecutionState({ mode: resolvedMode }));
  }
  // 会话自己的新记录优先于项目偏好；旧记录仅兼容读取，不批量回填。
  const executionEntries = await this.sessionStore.sessionEntries?.({
    sessionID: this.sessionId,
    type: SESSION_ENTRY_EXECUTION_STATE,
  });
  const savedExecution = executionStateSchema.safeParse(executionEntries?.at(-1)?.data);
  if (savedExecution.success && options?.modeOverride === undefined) {
    Object.assign(this.config, savedExecution.data);
  }
  await restoreRuntimeOrchestrationMode(this);
  // onDemand 会话的工具面随记录恢复（launch.md「On demand: activation」）：entry 在场，或历史里
  // 有过 `/workflow` / 十个工具的调用。要在首轮之前完成，所以放在 resume 里而不是等下一次 turn。
  await restoreDynamicWorkflowActivationOnResume.call(this, messages);

  await restorePermissionGrantMarker(this, traceContext);

  this.mainTurnCacheHitAggregate = mainTurnCacheHitAggregateFromMessages({
    activeMessages,
    persistedMessages: messages,
  });
  this.turnNumber = activeMessages.filter(
    (message) => message.info.role === "user" && !message.info.summary,
  ).length;
  this.sessionPersisted = true;
  if (this.teamBoardPort) {
    await this.teamBoardPort.execute({ action: "list" }, "coordinator");
  }
  const interruptedAgents = await restorePersistedLocalAgents(this, restoredEvents);
  for (const agent of interruptedAgents) {
    if (agent.isBackgrounded) {
      await this.appendEvent(
        this.createEvent(
          SessionEventType.BackgroundTaskCompleted,
          {
            taskId: agent.agentId,
            // 冷恢复终态沿用出生分支与真实运行身份，避免下次恢复被错归初始分支。
            branchGeneration: agent.branchGeneration ?? this.branchGeneration,
            ...(agent.traceContext?.spanId ? { runId: agent.traceContext.spanId } : {}),
            toolCallId: String(agent.parentToolCallId ?? ""),
            toolName: "Agent",
            taskKind: "subagent",
            childSessionId: agent.childSessionId,
            cancellable: false,
            description: agent.description,
            status: "lost",
            startedAt: agent.startedAt,
            completedAt: agent.completedAt,
          },
          traceContext,
        ),
        traceContext,
      );
    }
    const lostEvent = this.createEvent(
      SessionEventType.SubagentStopped,
      {
        agentId: agent.agentId,
        agentType: agent.agentType,
        branchGeneration: agent.branchGeneration ?? this.branchGeneration,
        ...(agent.traceContext?.spanId ? { runId: agent.traceContext.spanId } : {}),
        background: agent.isBackgrounded === true,
        childSessionId: agent.childSessionId,
        parentToolCallId: agent.parentToolCallId,
        status: "lost",
        error: agent.error,
      },
      traceContext,
    );
    if (await persistTeamMemberEvent(this, lostEvent))
      await this.appendEvent(lostEvent, traceContext);
  }
  await syncPersistedSessionTitleForResume.call(this, {
    restoredEvents,
    session,
    traceContext,
  });
  await this.discardPersistedPendingSteerInputs(traceContext);
  const recoveredSteerInputCount = 0;
  const resumedTodos = await this.readSessionTodosForContext(traceContext);
  const resumedTarget = await this.readSessionTargetForContext(traceContext);
  this.injectTargetStateIntoMessageHistory(resumedTarget);

  const resumedEvent = this.createEvent(
    SessionEventType.SessionResumed,
    {
      directory: session.directory,
      interruptedToolCount: hydration.interruptedToolCount,
      messageCount: hydration.messageCount,
      partCount: hydration.partCount,
      recoveredCompactTimelineCount,
      recoveredSteerInputCount,
      resumedTodoCount: resumedTodos.length,
      resumedTarget: resumedTarget?.status,
    },
    traceContext,
  );
  await this.appendEvent(resumedEvent, traceContext);
  const sessionStartHookResult = await this.runSessionStartHooks(
    "resume",
    traceContext,
    options?.abortSignal,
  );
  this.injectHookAdditionalContextIntoMessageHistory(
    HookEventName.SessionStart,
    sessionStartHookResult.additionalContexts,
  );
  if (this.teamMessageLedger && this.subagentPort?.sendMessage) {
    try {
      await this.teamMessageLedger.replay({
        branchGeneration: this.branchGeneration,
        canDeliver: true,
        resolveMember: (agentId) => {
          const task = this.runtimeTaskRegistry.get(agentId);
          return task?.teamMemberName && task.parentSessionId === this.sessionId
            ? { childSessionId: task.childSessionId, status: task.status }
            : undefined;
        },
        send: (request) => this.subagentPort!.sendMessage!(request),
        trace: traceContext,
        workingDirectory: this.workingDirectory,
        workspaceRoot: this.workspaceRoot,
      });
    } catch (error) {
      this.logger?.warn("Team message recovery remains pending", {
        event: "team_message.replay_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        sessionId: this.sessionId,
      });
    }
  }

  if (messages.length > 0 && activeMessages.length === 0) {
    this.logger?.warn("Session resume produced zero active messages", {
      ...traceContextToLogContext(traceContext),
      activeMessageCount: activeMessages.length,
      appliedMessageCount: hydration.appliedMessageCount,
      directory: session.directory,
      event: "session.resume.active_messages_zero",
      hydrationMessageCount: hydration.messageCount,
      module: "core.runtime",
      persistedMessageCount: messages.length,
      recoveredCompactTimelineCount,
      rewindCreatedMessageId,
      rewindKeptMessageCount: rewindKeptMessageIds?.length ?? 0,
      sessionId: this.sessionId,
      rewindTargetMessageId,
    });
  }
  if (activeMessages.length > 0 && hydration.appliedMessageCount === 0) {
    this.logger?.warn("Session resume applied zero history messages", {
      ...traceContextToLogContext(traceContext),
      activeMessageCount: activeMessages.length,
      directory: session.directory,
      event: "session.resume.applied_messages_zero",
      hydrationMessageCount: hydration.messageCount,
      module: "core.runtime",
      persistedMessageCount: messages.length,
      recoveredCompactTimelineCount,
      rewindCreatedMessageId,
      rewindKeptMessageCount: rewindKeptMessageIds?.length ?? 0,
      rewindTargetMessageId,
      sessionId: this.sessionId,
    });
  }

  this.logger?.info("Session resumed", {
    ...traceContextToLogContext(traceContext),
    appliedMessageCount: hydration.appliedMessageCount,
    directory: session.directory,
    event: "session.resumed",
    interruptedToolCount: hydration.interruptedToolCount,
    messageCount: hydration.messageCount,
    module: "core.runtime",
    partCount: hydration.partCount,
    readFileStateRestoredCount: readFileStateHydration.restoredCount,
    readFileStateSkippedRangeReadCount: readFileStateHydration.skippedRangeReadCount,
    readFileStateSkippedUnreadableEditCount: readFileStateHydration.skippedUnreadableEditCount,
    recoveredCompactTimelineCount,
    resumedTodoCount: resumedTodos.length,
    resumedTargetStatus: resumedTarget?.status,
    sessionId: this.sessionId,
    status: "completed",
  });

  return {
    ...hydration,
    directory: session.directory,
    // 中断 compact 恢复会写回 timeline part；bootstrap 不能继续把恢复前
    // messages 交给 V4，否则首帧会短暂复活 started/retrying 状态。
    persistedMessagesReloadRequired: recoveredCompactTimelineCount > 0,
    readFileStateRestoredCount: readFileStateHydration.restoredCount,
    readFileStateSkippedRangeReadCount: readFileStateHydration.skippedRangeReadCount,
    readFileStateSkippedUnreadableEditCount: readFileStateHydration.skippedUnreadableEditCount,
    traceId: traceContext.traceId,
  };
}
