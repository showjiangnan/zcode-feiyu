// Modified by ZCode Feiyu.
// 按职责拆分数据合同；存储端口继续作为唯一持久化边界，不新增写入 owner。
import type { SessionId, MessageId, PartId, ProjectId } from "./shared.js";
import type {
  CreateSessionInput,
  SessionInfo,
  ForkChildSessionMetadata,
  ForkCommitBundle,
  UpdateSessionInput,
  ListSessionsInput,
  SessionRevert,
  FileDiff,
} from "./session-store-metadata.js";
import type { ModelSelection } from "../model/index.js";
import type {
  SharedContextImportCommitBundle,
  SharedContextImportTransition,
  MessagePart,
  MessageWithParts,
} from "./session-store-parts.js";
import type {
  ProjectMemoryExtractionCursorPort,
  ProjectMemoryReviewClaimInput,
  ProjectMemoryReviewClaim,
  ProjectMemoryReviewRecord,
  ProjectMemoryReviewFinishInput,
} from "./session-store-memory.js";
import type {
  ClaimLegacySessionWorkspaceInput,
  RepairLegacyRemoteSessionWorkspaceInput,
  RepairRemoteSessionPathsInput,
} from "./session-store-maintenance.js";
import type { MessageInfo } from "./session-store-messages.js";
import type {
  SessionEntryInfo,
  SessionEntryType,
  SessionInputDelivery,
  SessionInputStatus,
  SessionInputRecord,
} from "./session-store-ledger.js";
import type { TodoItem } from "../tools/todo.js";
import type { SessionGoal, GoalStatus } from "../tools/target.js";
import type { PermissionRuleset } from "./permission.port.js";

export interface SessionStorePort {
  /** lifecycle 事实与原 event/trigger 同事务；调用返回后才允许对外确认源事件。 */
  publishProactiveEvent?(input: {
    eventId: string;
    workspaceKey: string;
    sourceSessionId: string;
    sourceId: string;
    kind: "task_completed" | "task_failed" | "mailbox_message" | "automation_due";
    targetSessionId?: string;
    depth: number;
    now: number;
    lifecycle?: {
      eventId: string;
      type: "turn_started" | "turn_complete" | "turn_error";
      turnId?: string;
      commandId: string;
    };
  }): Promise<void>;
  listProactiveMailboxTargets?(workspaceKey: string): Promise<string[]>;
  claimProactiveTriggers?(
    workspaceKey: string,
    ownerId: string,
    now: number,
  ): Promise<
    Array<{
      triggerId: string;
      sourceSessionId: string;
      targetSessionId: string;
      commandId: string;
      prompt: string;
      generation: number;
      depth: number;
    }>
  >;
  settleProactiveTrigger?(input: {
    triggerId: string;
    ownerId: string;
    status: "delivered" | "rejected" | "pending";
    error?: string;
    now: number;
  }): Promise<void>;
  readProactiveTrigger?(commandId: string): Promise<{
    targetSessionId: string;
    generation: number;
    depth: number;
    state: "pending" | "dispatching" | "delivered" | "rejected";
  } | null>;
  /** 活跃会话由其 runtime 发布编排事件；这里只暂停未加载会话。 */
  pauseProactiveWorkspace?(
    workspaceKey: string,
    reason: string,
    activeSessionIds?: readonly string[],
  ): Promise<void>;
  /** 当前许可确认后恢复旧执行限额暂停；跳过活动 runtime，由其自身负责状态发布。 */
  resumeRetiredProactiveWorkspace?(
    workspaceKey: string,
    now: number,
    activeSessionIds?: readonly string[],
  ): Promise<void>;
  /** 只接受该发送者已提升的原 commandId；无法证明来源时返回 null，不按时间猜测。 */
  proactiveDepthForSource?(sourceSessionId: string, commandId: string): Promise<number | null>;
  /** 单调合并到原已提升输入，保证运行中 Mailbox 消费在冷恢复后仍有准确因果。 */
  mergeProactiveInputCause?(
    sessionId: SessionId,
    cause: import("@zcode/shared/zcode-protocol-v4").ProactiveCausalContext,
  ): Promise<void>;
  rejectSupersededProactiveTriggers?(
    targetSessionId: string,
    generation: number,
    reason: string,
    now: number,
  ): Promise<number>;
  /** 图片付费许可和首次提交意图同事务固定；每个输入最多一个新作业。 */
  claimImageGenerationSubmission?(input: {
    sessionId: SessionId;
    inputId: string;
    job: import("@zcode/shared").ImageGenerationJob;
  }): Promise<boolean>;
  createSession(input: CreateSessionInput): Promise<SessionInfo>;
  /**
   * 持久 create 的幂等边界：workspaceID.trim() || directory + commandId 唯一。
   * session、来源与初始模型同事务；重试只读首次身份，参数冲突/归档拒绝。
   * 缺席时调用方必须失败，禁止退回不带来源的普通 createSession。
   */
  getOrCreateSessionByOrigin?(
    input: CreateSessionInput,
    origin: {
      commandId: string;
      requestFingerprint: string;
      commandFingerprint?: string;
      modelSelection?: ModelSelection;
    },
  ): Promise<SessionInfo>;
  readSessionCreateOrigins?(
    commandId: string,
  ): Promise<Array<{ sessionId: SessionId; workspaceKey: string; commandFingerprint: string }>>;
  /** legacy 兼容原语；V4 stable/compact-edit fork 禁止调用，统一走 commitForkBundle。 */
  createForkedSessionWithMetadata?(
    input: CreateSessionInput,
    metadata: ForkChildSessionMetadata,
  ): Promise<SessionInfo>;
  /** V4 stable/compact-edit fork 的唯一事务入口。legacy workspace fork 不调用。 */
  commitForkBundle?(bundle: ForkCommitBundle): Promise<SessionInfo>;
  commitSharedContextImportBundle?(bundle: SharedContextImportCommitBundle): Promise<SessionInfo>;
  transitionSharedContextImport?(input: SharedContextImportTransition): Promise<boolean>;
  updateSession(input: UpdateSessionInput): Promise<SessionInfo>;
  getSession(sessionID: SessionId): Promise<SessionInfo | null>;
  listSessions(input?: ListSessionsInput): Promise<SessionInfo[]>;
  readProjectMemoryExtractionCursor?(sessionId: SessionId): Promise<MessageId | undefined>;
  /**
   * 与分支撤回、文件最终提交共用排他屏障。回调须在此处复核来源分支，再使用受限 cursor。
   * 禁止回调内调用 setRevert/公开 advance 等再次取锁的写入口；cursor 在回调结束后失效。
   */
  withProjectMemoryExtractionFence?<T>(
    sessionId: SessionId,
    commit: (cursor: ProjectMemoryExtractionCursorPort) => Promise<T>,
  ): Promise<T>;
  advanceProjectMemoryExtractionCursor?(input: {
    sessionId: SessionId;
    expectedCursor?: MessageId;
    nextCursor: MessageId;
    now: number;
  }): Promise<boolean>;
  claimProjectMemoryWrite?(input: {
    workspaceKey: string;
    ownerId: string;
    now: number;
    leaseDurationMs: number;
  }): Promise<{ status: "claimed"; epoch: number } | { status: "leased" }>;
  withProjectMemoryWriteFence?<T>(
    input: {
      workspaceKey: string;
      ownerId: string;
      epoch: number;
    },
    commit: () => Promise<T>,
  ): Promise<T>;
  renewProjectMemoryWrite?(input: {
    workspaceKey: string;
    ownerId: string;
    epoch: number;
    now: number;
    leaseDurationMs: number;
  }): Promise<boolean>;
  releaseProjectMemoryWrite?(input: {
    workspaceKey: string;
    ownerId: string;
    epoch: number;
  }): Promise<boolean>;
  claimProjectMemoryReview?(
    input: ProjectMemoryReviewClaimInput,
  ): Promise<ProjectMemoryReviewClaim>;
  /**
   * 只读门槛进度（复审 GAP-05）：用与 `claimProjectMemoryReview` 完全相同的候选口径统计
   * 「距上次成功后已变化的顶层会话数」，因此界面显示的数字就是准入判定用的数字。
   * 只统计不写入，可在整理运行期间安全调用。
   */
  readProjectMemoryReviewThreshold?(input: {
    workspaceKey: string;
    workspacePath: string;
    currentSessionId: SessionId;
    historyScope: "workspace" | "current_session" | "none";
    now: number;
  }): Promise<import("@zcode/shared").MemoryReviewThresholdProgress>;
  renewProjectMemoryReview?(input: {
    workspaceKey: string;
    reviewId: string;
    epoch: number;
    now: number;
    leaseDurationMs: number;
    stage?: ProjectMemoryReviewRecord["stage"];
    totalTokens?: number;
    changedFiles?: string[];
    sessionCount?: number;
    tokenUsageEstimated?: boolean;
  }): Promise<boolean>;
  requestCancelProjectMemoryReview?(input: {
    workspaceKey: string;
    reviewId: string;
  }): Promise<boolean>;
  finishProjectMemoryReview?(
    input: ProjectMemoryReviewFinishInput,
  ): Promise<"completed" | "failed" | "cancelled" | "stale">;
  /**
   * 构造整理任务的提交点栅栏；`assertHeld` 在写租约排他事务内同步复核该 review 的
   * reviewId/epoch 仍然有效，失效时抛错，禁止静默跳过。
   */
  projectMemoryReviewFence?(input: {
    workspaceKey: string;
    reviewId: string;
    epoch: number;
  }): import("./file-system.port.js").MemoryCommitFence;
  getProjectMemoryReview?(workspaceKey: string): Promise<ProjectMemoryReviewRecord | null>;
  listProjectMemoryReviews?(
    workspaceKey: string,
    before?: { startedAt: number; reviewId: string },
  ): Promise<import("@zcode/shared").MemoryReviewRun[]>;
  /**
   * 用 host task-index allowlist 为旧远端 session 补写 workspace identity。
   * 实现必须同时校验 id、directory 与 workspace_id is null，禁止覆盖已有 identity。
   */
  claimLegacySessionWorkspace?(input: ClaimLegacySessionWorkspaceInput): Promise<number>;
  /**
   * 修复曾把 remote identity 写入 directory/path 的单条历史 session。
   * 实现必须校验 session id、NULL workspace_id 及旧目录精确匹配，禁止批量路径迁移。
   */
  repairLegacyRemoteSessionWorkspace?(
    input: RepairLegacyRemoteSessionWorkspaceInput,
  ): Promise<boolean>;
  /**
   * 已有 remote identity 的维护性路径自愈 CAS。
   * 实现只能更新 directory、path 和单调 time_updated，禁止写回其它 session 元数据。
   */
  repairRemoteSessionPaths?(input: RepairRemoteSessionPathsInput): Promise<boolean>;
  saveMessage(input: MessageInfo, copyFrom?: { sessionID: SessionId; id: string }): Promise<void>;
  removeMessage(input: { sessionID: SessionId; messageID: MessageId }): Promise<void>;
  savePart(input: MessagePart, copyFrom?: { sessionID: SessionId; id: string }): Promise<void>;
  removePart(input: { sessionID: SessionId; messageID: MessageId; partID: PartId }): Promise<void>;
  messageWithParts(input: {
    sessionID: SessionId;
    messageID: MessageId;
  }): Promise<MessageWithParts | null>;
  messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]>;
  saveSessionEntry?(input: SessionEntryInfo): Promise<void>;
  sessionEntries?(input: {
    sessionID: SessionId;
    type?: SessionEntryType | string;
  }): Promise<SessionEntryInfo[]>;
  // ── session_input 账本（可选方法，旧宿主可不实现）──
  /** admission：输入已被接受（排队/待注入），durable 记账。幂等（同 id 重入更新 payload）。 */
  saveSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  }): Promise<void>;
  /** 审批完全访问：execution、固定队列权限和幂等 receipt 同一事务；无 schema migration。 */
  commitPermissionFullAccess?(input: {
    sessionID: SessionId;
    queueItemIds: string[];
    execution: SessionEntryInfo;
    receipt: SessionEntryInfo;
    signal?: AbortSignal;
  }): Promise<void>;
  /** queue 编辑/重排的 durable 原子更新；只允许修改 admitted 记录。 */
  updateSessionInputs?(input: {
    sessionID: SessionId;
    updates: Array<{
      delivery?: SessionInputDelivery;
      id: string;
      intent?: import("./session.port.js").TurnInputIntentMetadata;
      text?: string;
      queuePosition?: number;
    }>;
  }): Promise<void>;
  /**
   * promotion（原子性硬要求）：账本置 promoted + user message/parts
   * 持久化在同一事务——杜绝「queue 已消费但 transcript 无 user message」的孤儿窗口。
   */
  promoteSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  }): Promise<void>;
  /**
   * 非原子 promotion 标记：message 持久化已在别处完成的路径（background wake 的
   * synthetic notice）只补账本状态。新路径应优先用 promoteSessionInput（原子）。
   */
  markSessionInputPromoted?(input: {
    id: string;
    sessionID: SessionId;
    promotedMessageID: MessageId;
  }): Promise<void>;
  /** 终态收口：cancelled（user_removed 等）/ discarded（session_resumed / user_cleared）。 */
  settleSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  }): Promise<void>;
  listSessionInputs?(input: {
    sessionID: SessionId;
    status?: SessionInputStatus;
  }): Promise<SessionInputRecord[]>;
  /** global createSession.firstInput 查重：由 queue_<sourceCommandId> 找回真实 session。 */
  getSessionInputById?(id: string): Promise<SessionInputRecord | null>;
  readTodos(input: { sessionID: SessionId }): Promise<TodoItem[]>;
  updateTodos(input: { sessionID: SessionId; todos: TodoItem[] }): Promise<void>;
  readTarget(input: { sessionID: SessionId }): Promise<SessionGoal | null>;
  setTarget(input: {
    objective: string;
    sessionID: SessionId;
    status?: GoalStatus;
    tokenBudget?: number | null;
  }): Promise<SessionGoal>;
  cloneTargetForFork?(input: {
    source: SessionGoal;
    sessionID: SessionId;
    status?: GoalStatus;
  }): Promise<SessionGoal>;
  createTarget(input: {
    objective: string;
    sessionID: SessionId;
    tokenBudget?: number | null;
  }): Promise<SessionGoal | null>;
  updateTargetStatus(input: {
    sessionID: SessionId;
    status: GoalStatus;
  }): Promise<SessionGoal | null>;
  startTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  }): Promise<SessionGoal | null>;
  heartbeatTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  }): Promise<SessionGoal | null>;
  finishTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    tokensUsedDelta?: number;
  }): Promise<SessionGoal | null>;
  recoverInterruptedTargetRun?(input: { sessionID: SessionId }): Promise<SessionGoal | null>;
  accountTargetUsage(input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
  }): Promise<SessionGoal | null>;
  updateTargetSummaryTitle(input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  }): Promise<SessionGoal | null>;
  clearTarget(input: { sessionID: SessionId }): Promise<boolean>;
  getProjectPermission(projectID: ProjectId): Promise<PermissionRuleset | null>;
  saveProjectPermission(input: {
    projectID: ProjectId;
    permission: PermissionRuleset;
  }): Promise<PermissionRuleset>;
  setRevert(input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  }): Promise<void>;
  clearRevert(sessionID: SessionId): Promise<void>;
}

export * from "./session-store-metadata.js";
export * from "./session-store-memory.js";
export * from "./session-store-maintenance.js";
export * from "./session-store-messages.js";
export * from "./session-store-parts.js";
export * from "./session-store-ledger.js";
export * from "./session-store-usage.js";
