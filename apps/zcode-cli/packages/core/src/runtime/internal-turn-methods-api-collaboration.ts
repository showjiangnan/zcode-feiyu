// Modified by ZCode Feiyu.
import type { BackgroundBashOutputResult } from "@zcode/shared";

import type {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  BackgroundExecutionSnapshot,
  BackgroundTaskCancelResult,
  BackgroundTaskInfo,
  BackgroundTaskInfoStatus,
  MessageId,
  Model,
  ModelNetworkStatusEvent,
  ModelStatusSink,
  ModelStreamRecoveryStatus,
  PermissionBrokerRequest,
  SessionEvent,
  SessionId,
  SessionProjection,
  ToolCallId,
  TraceContext,
  TurnId,
  ToolCall,
  ToolSchedule,
  ToolExecutionResult,
} from "./deps.js";
import type {
  ConversationBeforeInputForkOptions,
  ExecuteToolsOptions,
  ExecuteToolsResult,
  PermissionDecisionResult,
  SelectionSideChatCreateOptions,
  StableConversationForkOptions,
  WorkspaceCheckpointSummary,
  WorkspaceFileRewindApplyResult,
  WorkspaceFileRewindPreview,
  WorkspaceForkResult,
} from "./types.js";
import type { RuntimeMessageEntry } from "../agent/message-history.js";
import type {
  RuntimeBackgroundStopOptions,
  RuntimeBackgroundStopResult,
} from "./methods/background.js";
import type { CompactAttemptOutcome } from "./methods/turn-loop-state.js";

export interface AgentRuntimeTurnMethodsCollaboration {
  compactActiveConversation(
    customInstructions: string | undefined,
    turnTraceContext: TraceContext,
    events: SessionEvent[],
    options?: {
      abortSignal?: AbortSignal;
      compactContextTelemetry?: {
        inputTokens: number;
        policyContextWindowTokens: number;
        thresholdTokens?: number;
        tokenSource: "estimate" | "provider_usage";
      };
      autoCompactThreshold?: number;
      compactReason?: CompactReason;
      initialPromptTooLongCause?: unknown;
      phase?: CompactPhase;
      sourceCommandId?: string;
      trigger?: CompactTrigger;
      model?: Model;
      agentListingTools?: readonly { name: string }[];
      activeEntries?: readonly RuntimeMessageEntry[];
    },
  ): Promise<{
    displayText: string;
    entries: readonly RuntimeMessageEntry[];
    outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
    tokenCount: number;
  }>;

  scheduleTools(toolCalls: ToolCall[]): Promise<ToolSchedule>;

  executeTools(
    toolCalls: ToolCall[],
    schedule: ToolSchedule,
    options?: ExecuteToolsOptions,
  ): Promise<ExecuteToolsResult>;

  emitToolScheduledEvents(
    toolCalls: ToolCall[],
    schedule: ToolSchedule,
    assistantMessageId: MessageId,
    traceContext: TraceContext,
  ): Promise<SessionEvent[]>;

  emitFileMutationCheckpoint(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    messageId: MessageId;
    result: ToolExecutionResult;
    toolMessageId?: MessageId;
    traceContext: TraceContext;
  }): Promise<void>;

  emitPermissionRequest(toolCallId: ToolCallId, toolName: string, riskLevel: string): Promise<void>;

  resolvePermission(toolCallId: ToolCallId, decision: PermissionDecisionResult): Promise<void>;

  getPendingPermissionRequests(): PermissionBrokerRequest[];

  getProjection(): Promise<SessionProjection>;

  readBackgroundBashOutput(workId: string, sessionId?: string): Promise<BackgroundBashOutputResult>;

  cancelBackgroundTask(
    taskId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<BackgroundTaskCancelResult>;

  stopBackgroundTask(
    taskId: string,
    options: RuntimeBackgroundStopOptions,
  ): Promise<RuntimeBackgroundStopResult>;

  /**
   * 取消本 runtime 正在跑的整理。迟到取消必须带原 reviewId——同一 runtime 里已经接管的新整理
   * 不能被旧回执停掉。后台抽屉的记忆整理条目按这条既存路径停止（复审 GAP-03），不新增取消能力。
   */
  cancelProjectMemoryReview(expectedReviewId?: string): boolean;

  cancelRunningRuntimeBackgroundTasks(input: {
    reason: "subagent_cancelled";
    traceContext?: TraceContext;
  }): Promise<void>;

  hasRunningBackgroundTasks(): boolean;

  getSessionId(): SessionId;

  listWorkspaceCheckpoints(options?: { limit?: number }): Promise<WorkspaceCheckpointSummary[]>;

  forkWorkspaceFromCheckpoint(options?: {
    abortSignal?: AbortSignal;
    forkedSessionId?: SessionId;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    traceContext?: TraceContext;
  }): Promise<WorkspaceForkResult>;

  forkStableConversationAtMessage(
    options: StableConversationForkOptions,
  ): Promise<WorkspaceForkResult>;

  createSelectionSideConversation(
    options: SelectionSideChatCreateOptions,
  ): Promise<WorkspaceForkResult>;

  forkConversationBeforeMessage(
    options: ConversationBeforeInputForkOptions,
  ): Promise<WorkspaceForkResult>;

  previewWorkspaceFileRewind(options?: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
  }): Promise<WorkspaceFileRewindPreview>;

  applyWorkspaceFileRewind(options?: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
    commitAfterApply?: () => Promise<void>;
  }): Promise<WorkspaceFileRewindApplyResult>;

  loadCheckpointMessagePreviews(): Promise<Map<MessageId, string>>;

  createModelStatusSink(
    traceContext: TraceContext,
    events: SessionEvent[],
    options?: {
      persist?: boolean;
      onStatus?: (event: ModelNetworkStatusEvent) => void;
      streamRecovery?: ModelStreamRecoveryStatus;
    },
  ): ModelStatusSink;

  logModelNetworkStatus(statusEvent: ModelNetworkStatusEvent, traceContext: TraceContext): void;

  buildBackgroundTaskPayload(
    taskId: string,
    existing: BackgroundTaskInfo | undefined,
    snapshot: BackgroundExecutionSnapshot | undefined,
    overrides?: {
      cancelRequestedAt?: Date;
      cancellable?: boolean;
      completedAt?: Date;
      status?: BackgroundTaskInfoStatus;
    },
  ): BackgroundTaskInfo;
}
