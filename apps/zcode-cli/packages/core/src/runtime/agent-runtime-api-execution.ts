// Modified by ZCode Feiyu.
import type {
  CollaborationMode,
  ExecutionShellSelection,
  MessageId,
  ModelSelection,
  ProjectId,
  TraceContext,
  TurnInputIntentMetadata,
  TurnState,
  TurnSteerInput,
  TurnSteerResult,
} from "./deps.js";

import { type ProjectMemoryReviewOutcome } from "./helpers/project-memory-review.js";

import type { ComputerUseRefreshInput } from "./methods/computer-use-refresh.js";

import type {
  AcquireForegroundPromotionLeaseResult,
  ActiveTurnInfo,
  AgentRuntimeConfig,
  ForegroundPromotionLeaseMode,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
} from "./types.js";

export interface AgentRuntimeExecution {
  refreshComputerUse(input: ComputerUseRefreshInput): Promise<boolean>;

  lastPermissionGrantId?: string;

  beginShutdown(): void;

  reviewProjectMemoryNow(sourceSessionId?: string): Promise<ProjectMemoryReviewOutcome>;

  cancelProjectMemoryReview(expectedReviewId?: string): boolean;

  closeBrowserSession(): Promise<void>;

  updateConfig(
    patch: Pick<AgentRuntimeConfig, "mode" | "planEnabled" | "language" | "outputStyle">,
  ): void;

  initializeSessionShellEnvironmentIfNeeded(
    selection: ExecutionShellSelection | (() => ExecutionShellSelection),
  ): boolean;

  getSessionShellSelection(): ExecutionShellSelection | undefined;

  getMode(): CollaborationMode;

  getPlanEnabled(): boolean;

  grantPermissionFullAccess(interactionId: string, signal?: AbortSignal): Promise<string>;

  setExecutionState(
    input: { mode?: string; planEnabled?: boolean },
    traceContext?: TraceContext,
  ): Promise<void>;

  getSessionModelSelection(): ModelSelection | undefined;

  setSessionModelSelection(selection: ModelSelection | undefined): void;

  getProjectId(): ProjectId;

  ensureSessionPersistedForExternalActivity(
    input: string,
    options?: { traceContext?: TraceContext },
  ): Promise<void>;

  maybeStartSessionTitleGenerationFromExternalInput(
    input: string,
    options?: { goalSummaryTargetID?: string; traceContext?: TraceContext },
  ): void;

  /** renameSession：用户显式重命名（titleSource=custom，发 SessionTitleUpdated）。 */
  setCustomSessionTitle(input: { title: string; traceContext: TraceContext }): Promise<void>;

  maybeStartGoalSummaryTitleGeneration(
    input: string,
    targetID: string,
    options?: { traceContext?: TraceContext },
  ): boolean;

  recordExternalUserPrompt(
    input: string,
    options?: {
      goalSummaryTargetID?: string;
      traceContext?: TraceContext;
      intent?: TurnInputIntentMetadata;
    },
  ): Promise<MessageId>;

  recordPendingModelChange(input: {
    fromModel?: ModelSelection;
    fromModelLabel?: string;
    toModel: ModelSelection;
    toModelLabel: string;
  }): void;

  getActiveTurnInfo(): ActiveTurnInfo | undefined;

  admitPrompt(
    input: string,
    attachments?: TurnState["attachments"],
    options?: PromptAdmissionOptions,
  ): Promise<PromptAdmissionReceipt>;

  /** Session 常驻池使用的 runtime busy 权威事实，包含 queue/drain/reservation。 */
  hasActiveOrQueuedTurnWork(): boolean;

  /** Session 常驻池使用的后台 Bash/Agent/Workflow running 权威事实。 */
  hasRunningBackgroundTasks(): boolean;

  /**
   * Session 常驻池唯一消费的 runtime owned-work 聚合事实。
   * 包含前台/队列、registry background task、detached sidecar 和 memory work。
   */
  hasResidencyBlockingWork(): boolean;

  /**
   * 登记一段会越过当前同步调用栈的 runtime-owned work，计数在**本同步片**增加、在 promise 的
   * finally 释放（实现见 runtime/methods/residency.ts）。
   *
   * 公开在这一面上，是因为 runtime 之外的 sidecar 也要经同一个口登记：dwf 引擎跑在会话 App 里、
   * 不进 runtime task registry，因此出现「引擎在飞时会话被按 idle 关掉」。
   * 新增 sidecar 一律登记到这里，而不是在 bootstrap 侧另加一条猜测。
   */
  trackResidencyBlockingWork<T>(work: Promise<T>): Promise<T>;

  /**
   * 会话是否已落进持久化 store。协议层 record 的 draft（deferred）判定以此为事实源：任何经 runtime
   * 首次持久化的路径（首条输入、外部活动、中枢直接启动的启动轮）都会让会话离开 draft。
   */
  isSessionPersisted(): boolean;

  getActiveForegroundExecutionId(): string | undefined;

  acquireForegroundPromotionLease(options: {
    leaseId: string;
    mode: ForegroundPromotionLeaseMode;
    promotedInputId: string;
  }): AcquireForegroundPromotionLeaseResult;

  releaseForegroundPromotionLease(leaseId: string): boolean;

  enqueueDeferredInput(input: string | TurnSteerInput): Promise<TurnSteerResult>;

  steerTurn(input: string | TurnSteerInput): Promise<TurnSteerResult>;

  /** v4 queue 单项删除：按 pendingInputId 移除当前 active turn 的一条排队输入。 */
  removePendingInputById(options: {
    pendingInputId: string;
    reason: "user_removed" | "promoted";
    reservationId?: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;

  reservePendingInputById(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;

  markPendingInputPromoting(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;

  releasePendingInputReservation(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
}
