// Modified by ZCode Feiyu.
import type { OrchestrationState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type { RuntimeTelemetryFacade } from "../telemetry/runtime-telemetry.js";
import type { RuntimeCommandQueue } from "./command-queue.js";
import type {
  ContextBuilder,
  ContextBuildResult,
  ContextSourcePort,
  ContextSourceSnapshot,
  DynamicWorkflowRunPort,
  EventReducer,
  ExecutionPort,
  FileSystemPort,
  HookRunner,
  ImageProcessorPort,
  Logger,
  McpConnectionSnapshot,
  McpPort,
  MessageHistory,
  MessageId,
  ModelCatalogPort,
  ModelSelection,
  ModelToolContract,
  PdfDocumentPort,
  PermissionBrokerPort,
  ReadFileStateMap,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionMailboxPort,
  SessionStorePort,
  SkillLoadOutcome,
  SkillPort,
  SubagentPort,
  ToolArtifactStorePort,
  ToolExecutor,
  ToolRegistry,
  TraceContext,
  TurnId,
} from "./deps.js";
import { PermissionService, ToolScheduler } from "./deps.js";
import type { ProjectMemoryExtractionScheduler } from "./helpers/project-memory-extraction.js";
import type { ProjectMemoryReviewOutcome } from "./helpers/project-memory-review.js";
import type { AgentRuntimeHookMethods } from "./internal-hook-methods.js";
import type { AgentRuntimeCoreMethods } from "./internal-methods.js";
import type { AgentRuntimeTurnMethods } from "./internal-turn-methods.js";
import type { DynamicWorkflowActivationSource } from "./methods/dynamic-workflow-activation.js";
import type { TeamMessageLedger } from "./team-message-ledger.js";
import type {
  ActiveForegroundExecutionState,
  ActiveTurnStartReservation,
  ActiveTurnSteeringState,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  BackgroundTaskNotificationSealReason,
  ForegroundPromotionLeaseState,
  MainTurnCacheHitAggregate,
  PendingModelChangeTimeline,
  ProviderRuntimeHeadersPort,
  RuntimeTurnFileChangeMap,
} from "./types.js";

export interface AgentRuntimeInternal
  extends AgentRuntimeCoreMethods, AgentRuntimeTurnMethods, AgentRuntimeHookMethods {
  beginShutdown(): void;
  memoryPreferenceRevision: number;
  sessionId: SessionId;
  turnNumber: number;
  config: AgentRuntimeConfig;
  permissionService: PermissionService;
  permissionBroker: PermissionBrokerPort;
  toolScheduler: ToolScheduler;
  eventReducer: EventReducer;
  eventStore: SessionEventStorePort;
  rootTraceContext: TraceContext;
  appVersion: string;
  logger?: Logger;
  eventSinks: Set<SessionEventSink>;
  now: () => Date;
  isRemoteWorkspace: () => boolean;
  registry: ToolRegistry;
  executor: ToolExecutor;
  hookRunner?: HookRunner;
  workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  modelFactory: AgentRuntimeDeps["modelFactory"];
  modelIoDir?: string;
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  browserControlPort?: AgentRuntimeDeps["browserControlPort"];
  modelRequestAdmission?: AgentRuntimeDeps["modelRequestAdmission"];
  continuityPolicySource?: AgentRuntimeDeps["continuityPolicySource"];
  automationPort?: AgentRuntimeDeps["automationPort"];
  sessionModelSelection: ModelSelection | undefined;
  messageHistory: MessageHistory;
  readFileState: ReadFileStateMap;
  cachedTools: ModelToolContract[] | null;
  /** 工作流工具面是否已注册（launch.md「On demand: activation」）；非 onDemand 会话出生即 true。 */
  dynamicWorkflowToolsActivated: boolean;
  dynamicWorkflowActivationSource?: DynamicWorkflowActivationSource;
  contextBuilder: ContextBuilder | null;
  contextInitialized: boolean;
  contextSourceSnapshot?: ContextSourceSnapshot;
  latestContextBuildResult?: ContextBuildResult;
  memoryRoot?: string;
  memoryIndexContent?: string;
  memoryExtractionScheduler?: ProjectMemoryExtractionScheduler;
  memoryRecoveryTask?: Promise<void>;
  memoryRecoveryAbortController?: AbortController;
  memoryReviewAbortController?: AbortController;
  memoryReviewId?: string;
  memoryReviewTrigger?: "automatic" | "manual";
  memoryReviewTask?: Promise<ProjectMemoryReviewOutcome>;
  orchestration: OrchestrationState;
  orchestrationPersistedRevision: number;
  orchestrationMutation?: Promise<void>;
  /**
   * 连续主动轮次计数（复审 GAP-02）。只统计由主动事件触发的轮次，用户显式输入清零。
   * 只活在根 runtime 进程内：重启后重新计数，与「暂停本身已是持久事实」一致，
   * 不会在没有用户输入的情况下把已暂停的订阅重新放行。
   */
  paidImageInputId?: string;
  proactiveWork?: { controller: AbortController; settled: Promise<void> };
  contextSourcePort?: ContextSourcePort;
  skillPort?: SkillPort;
  mcpPort?: McpPort;
  mcpStartupPromise?: Promise<McpConnectionSnapshot>;
  residencyBlockingWorkCount: number;
  mcpInitialized: boolean;
  mcpToolsRegistered: boolean;
  /** 初始化 / 上次刷新时注册的 MCP 工具名与集合签名。 */
  registeredMcpToolNames?: string[];
  mcpToolsSignature?: string;
  mcpToolListRevision?: number;
  subagentPort?: SubagentPort;
  teamBoardPort?: import("@zcode/contracts").TeamBoardPort;
  teamMessageLedger?: TeamMessageLedger;
  getAgentDefinitions: NonNullable<AgentRuntimeDeps["getAgentDefinitions"]>;
  prepareAgentDefinitions: (input: {
    signal: AbortSignal;
    traceContext: TraceContext;
  }) => Promise<void>;

  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry: RuntimeTaskRegistry;
  branchGeneration: number;
  artifactStore?: ToolArtifactStorePort;
  executionPort?: ExecutionPort;
  fileSystemPort?: FileSystemPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  skillLoadOutcome?: SkillLoadOutcome;
  workingDirectory: string;
  workspaceRoot: string;
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  sessionPersisted: boolean;
  needsPlanModeExitReminder: boolean;
  latestConversationMessageId?: MessageId;
  latestAssistantMessageId?: MessageId;
  latestAssistantTurnId?: TurnId;
  mainTurnCacheHitAggregate: MainTurnCacheHitAggregate;
  currentTurnFileChanges: RuntimeTurnFileChangeMap;
  lastAssistantCompletedAtMs?: number;
  lastEmittedLocalDate?: string;
  autoCompactConsecutiveFailures: number;
  runtimeCommandQueue: RuntimeCommandQueue;
  runtimeCommandDrainActive: boolean;
  activeForegroundExecution?: ActiveForegroundExecutionState;
  foregroundPromotionLease?: ForegroundPromotionLeaseState;
  activeTurn?: ActiveTurnSteeringState;
  activeTurnStartReservation?: ActiveTurnStartReservation;
  pendingInputSequence: number;
  pendingInputReservations: Map<string, string>;
  permissionFullAccessPending?: boolean;
  pendingInputDrains?: number;
  lastPermissionGrantId?: string;
  queueAutoDrain: boolean;
  queueExternalDrainActive: boolean;
  shuttingDown: boolean;
  backgroundTaskNotificationsSealed: boolean;
  backgroundTaskNotificationSealReason?: BackgroundTaskNotificationSealReason;
  pendingModelChangeTimeline?: PendingModelChangeTimeline;
  sessionStartHookRan: boolean;
  sessionTitleGenerationAttempted: boolean;
  agentTelemetry: RuntimeTelemetryFacade;
}
