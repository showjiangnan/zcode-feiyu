// Modified by ZCode Feiyu.
import type { AgentRuntimeLifecycleApi } from "./agent-runtime-api-lifecycle.js";
import { createSessionEvent, SessionEventType } from "@zcode/contracts";

import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY, resolveExecutionState } from "@zcode/shared";
import {
  DEFAULT_ORCHESTRATION_STATE,
  type OrchestrationState,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";

import { InMemoryRuntimeTaskRegistry, type RuntimeTaskRegistry } from "../runtime-task/registry.js";
import {
  createAgentDefinitionsReader,
  createTurnAgentDefinitions,
  type GetAgentDefinitions,
} from "../subagent/definitions.js";
import { projectPersistentAgentMemoryTools } from "../subagent/persistent-memory.js";
import { RuntimeTelemetryFacade } from "../telemetry/runtime-telemetry.js";

import type { RuntimeCommandQueue } from "./command-queue.js";
import { createRuntimeCommandQueue } from "./command-queue.js";
import type {
  ContextBuilder,
  ContextBuildResult,
  ContextSourcePort,
  ContextSourceSnapshot,
  DynamicWorkflowRunPort,
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
import {
  createDenyPermissionBroker,
  createRootTraceContext,
  createToolRegistry,
  defaultPermissionConfig,
  EventReducer,
  MessageHistoryImpl,
  PermissionService,
  ToolScheduler,
  traceContextToLogContext,
} from "./deps.js";

import type { ProjectMemoryExtractionScheduler } from "./helpers/project-memory-extraction.js";
import { type ProjectMemoryReviewOutcome } from "./helpers/project-memory-review.js";

import { initializeRuntimeTooling } from "./helpers/runtime-tools.js";
import type { AgentRuntimeInternal } from "./internal.js";

import {
  resolveInitialDynamicWorkflowToolsActivated,
  type DynamicWorkflowActivationSource,
} from "./methods/dynamic-workflow-activation.js";

import { installAgentRuntimeMethods } from "./methods/index.js";

import { cloneModelSelection } from "./model-selection.js";

import { createTeamBoardPort } from "./team-board.js";
import { createTeamMessageLedger, type TeamMessageLedger } from "./team-message-ledger.js";
import type {
  ActiveForegroundExecutionState,
  ActiveTurnStartReservation,
  ActiveTurnSteeringState,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  ForegroundPromotionLeaseState,
  MainTurnCacheHitAggregate,
  PendingModelChangeTimeline,
  RuntimeTurnFileChangeMap,
} from "./types.js";
import type { AgentRuntimeExecution } from "./agent-runtime-api-execution.js";
import type { AgentRuntimeCollaboration } from "./agent-runtime-api-collaboration.js";
import type { AgentRuntimeSession } from "./agent-runtime-api-session.js";
import { installRuntimeLifecycleMethods } from "./runtime-lifecycle.js";

// oxlint-disable typescript-eslint/no-unsafe-declaration-merging
export class AgentRuntime {
  private sessionId: SessionId;
  private turnNumber: number;
  private config: AgentRuntimeConfig;
  private appVersion: string;
  private permissionService: PermissionService;
  private permissionBroker: PermissionBrokerPort;
  private toolScheduler: ToolScheduler;
  private eventReducer: EventReducer;
  private eventStore: SessionEventStorePort;
  private rootTraceContext: TraceContext;
  private logger?: Logger;
  private eventSinks = new Set<SessionEventSink>();
  private now: () => Date;
  private isRemoteWorkspace: () => boolean;
  private registry: ToolRegistry;
  private executor: ToolExecutor;
  private hookRunner?: HookRunner;
  private workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  private modelFactory: AgentRuntimeDeps["modelFactory"];
  private modelIoDir?: string;
  private providerRuntimeHeadersPort?: AgentRuntimeDeps["providerRuntimeHeadersPort"];
  private browserControlPort?: AgentRuntimeDeps["browserControlPort"];
  /** 模型请求准入端口；随每次模型请求进调用上下文。 */
  private modelRequestAdmission?: AgentRuntimeDeps["modelRequestAdmission"];
  private continuityPolicySource?: AgentRuntimeDeps["continuityPolicySource"];
  private automationPort?: AgentRuntimeDeps["automationPort"];
  private sessionModelSelection: ModelSelection | undefined;
  private messageHistory: MessageHistory;
  private readFileState: ReadFileStateMap;
  private cachedTools: ModelToolContract[] | null = null;
  /** launch.md「On demand: activation」：onDemand 会话出生为 false，`activateDynamicWorkflowTools` 翻为 true。 */
  private dynamicWorkflowToolsActivated: boolean;
  private dynamicWorkflowActivationSource?: DynamicWorkflowActivationSource;
  private contextBuilder: ContextBuilder | null = null;
  private contextInitialized = false;
  private contextSourceSnapshot?: ContextSourceSnapshot;
  private latestContextBuildResult?: ContextBuildResult;
  private memoryRoot?: string;
  private memoryIndexContent?: string;
  private memoryExtractionScheduler?: ProjectMemoryExtractionScheduler;
  private memoryRecoveryTask?: Promise<void>;
  private memoryRecoveryAbortController?: AbortController;
  private memoryReviewAbortController?: AbortController;
  private memoryReviewId?: string;
  private proactiveWork?: { controller: AbortController; settled: Promise<void> };
  private memoryReviewTrigger?: "automatic" | "manual";
  private memoryReviewTask?: Promise<ProjectMemoryReviewOutcome>;
  private memoryPreferenceRevision = 0;
  private orchestration: OrchestrationState = { ...DEFAULT_ORCHESTRATION_STATE };
  private orchestrationPersistedRevision = 0;
  private orchestrationMutation?: Promise<void>;
  private contextSourcePort?: ContextSourcePort;
  private skillPort?: SkillPort;
  private mcpPort?: McpPort;
  private mcpStartupPromise?: Promise<McpConnectionSnapshot>;
  private residencyBlockingWorkCount = 0;
  private mcpInitialized = false;
  private mcpToolsRegistered = false;
  private registeredMcpToolNames?: string[];
  private mcpToolsSignature?: string;
  private mcpToolListRevision?: number;
  private subagentPort?: SubagentPort;
  private teamBoardPort?: import("@zcode/contracts").TeamBoardPort;
  private teamMessageLedger?: TeamMessageLedger;
  private readonly getAgentDefinitions: GetAgentDefinitions;
  private readonly prepareAgentDefinitions: ReturnType<
    typeof createTurnAgentDefinitions
  >["prepare"];
  private dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  private modelCatalogPort?: ModelCatalogPort;
  private runtimeTaskRegistry: RuntimeTaskRegistry;
  private branchGeneration = 0;
  private artifactStore?: ToolArtifactStorePort;
  private executionPort?: ExecutionPort;
  private fileSystemPort?: FileSystemPort;
  private imageProcessorPort?: ImageProcessorPort;
  private pdfDocumentPort?: PdfDocumentPort;
  private skillLoadOutcome?: SkillLoadOutcome;
  private workingDirectory: string;
  private workspaceRoot: string;
  private sessionStore?: SessionStorePort;
  private sessionPersisted = false;
  private needsPlanModeExitReminder = false;
  private latestConversationMessageId?: MessageId;
  private latestAssistantMessageId?: MessageId;
  private latestAssistantTurnId?: TurnId;
  private mainTurnCacheHitAggregate: MainTurnCacheHitAggregate = {
    requestCount: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
  };
  private currentTurnFileChanges: RuntimeTurnFileChangeMap = new Map();
  private lastAssistantCompletedAtMs?: number;
  private lastEmittedLocalDate?: string;
  private autoCompactConsecutiveFailures = 0;
  private runtimeCommandQueue: RuntimeCommandQueue;
  private runtimeCommandDrainActive = false;
  private activeForegroundExecution?: ActiveForegroundExecutionState;
  /** sendQueuedNow 的 Core 调度权；只活在当前进程，匹配 runtime command 出队即消费。 */
  private foregroundPromotionLease?: ForegroundPromotionLeaseState;
  private activeTurn?: ActiveTurnSteeringState;
  private activeTurnStartReservation?: ActiveTurnStartReservation;
  private pendingInputSequence = 0;
  /** sendQueuedNow reservation；只活在当前 CLI 进程，防 drain/多端重复提升。 */
  private pendingInputReservations = new Map<string, string>();
  // v4 setAutoDrain：false 时排队输入不自动消费
  // （turn-stop 不续跑、roundtrip 间不 drain），保留成 held 供显式消费。
  private queueAutoDrain = true;
  // 暂停队列恢复后由 CLI 按投影 FIFO 逐项提升。这个窗口内禁止 core 只看当前
  // activeTurn.pendingInputs 做行内 drain，否则新入队消息会越过仍留在投影中的旧暂停项。
  private queueExternalDrainActive = false;
  private shuttingDown = false;
  private backgroundTaskNotificationsSealed = false;
  private backgroundTaskNotificationSealReason?: "subagent_terminal" | "subagent_cancelled";
  private pendingModelChangeTimeline?: PendingModelChangeTimeline;
  private sessionStartHookRan = false;
  private sessionTitleGenerationAttempted = false;
  private agentTelemetry: RuntimeTelemetryFacade;

  constructor(sessionId: SessionId, config: AgentRuntimeConfig, deps: AgentRuntimeDeps) {
    const runtime = this as unknown as AgentRuntimeInternal;
    this.sessionId = sessionId;
    this.turnNumber = 0;
    // 3.12.2：兼容旧 Host/内部调用传入 legacy，但本版本 Runtime、日志和子 Agent 只使用 preflight。
    this.config = projectPersistentAgentMemoryTools({
      ...config,
      modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    });
    Object.assign(this.config, resolveExecutionState(config));
    const definitions = createTurnAgentDefinitions(
      deps.getAgentDefinitions ??
        createAgentDefinitionsReader(this.config.subagents?.profiles ?? [], {
          builtInModelSelectionOverrides: this.config.subagents?.builtInModelSelectionOverrides,
        }),
      deps.loadAgentDefinitions,
    );
    this.getAgentDefinitions = definitions.get;
    this.prepareAgentDefinitions = definitions.prepare;
    this.agentTelemetry = new RuntimeTelemetryFacade({
      agentName: config.agentName,
      causation: deps.agentTelemetryCausation,
      causationMode: deps.agentTelemetryCausationMode,
      parentSessionId: config.parentSessionId,
      port: deps.agentTelemetry,
      sessionId,
      taskType: config.taskType,
    });
    this.permissionService =
      deps.permissionService ?? new PermissionService(defaultPermissionConfig);
    this.permissionBroker = deps.permissionBroker ?? createDenyPermissionBroker();
    this.toolScheduler =
      deps.toolScheduler ??
      new ToolScheduler({
        maxConcurrency: this.config.toolConcurrency?.maxConcurrency,
      });
    this.eventReducer = new EventReducer();
    this.eventStore = deps.eventStore;
    this.sessionStore = deps.sessionStore;
    this.rootTraceContext = deps.traceContext ?? createRootTraceContext({ sessionId });
    this.appVersion = deps.appVersion ?? "0.0.0";
    this.logger = deps.logger?.child({
      ...traceContextToLogContext(this.rootTraceContext),
      module: "core.runtime",
    });
    if (deps.eventSink) {
      this.eventSinks.add(deps.eventSink);
    }
    this.now = deps.now ?? (() => new Date());
    this.isRemoteWorkspace = deps.isRemoteWorkspace ?? (() => false);
    this.modelFactory = deps.modelFactory;
    this.modelIoDir = deps.modelIoDir;
    this.providerRuntimeHeadersPort = deps.providerRuntimeHeadersPort;
    this.browserControlPort = deps.browserControlPort;
    this.modelRequestAdmission = deps.modelRequestAdmission;
    this.continuityPolicySource = deps.continuityPolicySource;
    this.automationPort = deps.automationPort;
    // 旧会话的选择缺失不能阻断历史恢复；不在这里制造默认模型。
    this.sessionModelSelection =
      config.modelSelection && cloneModelSelection(config.modelSelection);
    this.messageHistory = new MessageHistoryImpl();
    this.readFileState = new Map();
    this.runtimeCommandQueue = createRuntimeCommandQueue();
    this.workingDirectory = config.workingDirectory ?? ".";
    this.contextSourcePort = deps.contextSourcePort;
    this.skillPort = deps.skillPort;
    this.mcpPort = deps.mcpPort;
    this.runtimeTaskRegistry = deps.runtimeTaskRegistry ?? new InMemoryRuntimeTaskRegistry();
    this.runtimeTaskRegistry.setActiveBranchGeneration?.(this.branchGeneration);
    this.teamBoardPort =
      deps.teamBoardPort ??
      (!config.parentSessionId && deps.sessionStore
        ? createTeamBoardPort(
            sessionId,
            deps.sessionStore,
            this.runtimeTaskRegistry,
            async (state) => {
              await this.appendEvent(
                createSessionEvent(SessionEventType.TeamBoardChanged, sessionId, state, {
                  traceId: this.rootTraceContext.traceId,
                }),
                this.rootTraceContext,
              );
            },
            () => this.branchGeneration,
          )
        : undefined);
    this.teamMessageLedger =
      !config.parentSessionId && deps.sessionStore
        ? createTeamMessageLedger(sessionId, deps.sessionStore)
        : undefined;
    this.artifactStore = deps.artifactStore;
    this.executionPort = deps.executionPort;
    this.fileSystemPort = deps.fileSystemPort;
    this.imageProcessorPort = deps.imageProcessorPort;
    this.pdfDocumentPort = deps.pdfDocumentPort;
    this.subagentPort = deps.subagentPort ?? runtime.createDefaultSubagentPort(deps);
    this.dynamicWorkflowRunPort = deps.dynamicWorkflowRunPort;
    // GUI「配置」解析子代理模型用的目录（与工具上下文拿的是同一个端口）。
    this.modelCatalogPort = deps.modelCatalogPort;
    this.registry = deps.toolRegistry ?? createToolRegistry();
    this.workspaceRoot = this.workingDirectory;
    // 必须先于工具装配：registerRuntimeBuiltInTools 的灰度门读的就是这个状态。
    this.dynamicWorkflowToolsActivated = resolveInitialDynamicWorkflowToolsActivated(this.config);
    const tooling = initializeRuntimeTooling(runtime, deps, sessionId);
    this.hookRunner = tooling.hookRunner;
    this.workspaceHookAdmission = deps.workspaceHookAdmission;
    this.executor = tooling.executor;

    this.contextBuilder = deps.contextBuilder ?? null;
    if (this.contextBuilder) {
      runtime.initializeMessageHistoryFromContext(this.contextBuilder, this.rootTraceContext);
      this.contextInitialized = true;
    }
    runtime.startMcpStartup(this.rootTraceContext);
  }
}
export interface AgentRuntime
  extends
    AgentRuntimeLifecycleApi,
    AgentRuntimeExecution,
    AgentRuntimeCollaboration,
    AgentRuntimeSession {}
installAgentRuntimeMethods(AgentRuntime);
installRuntimeLifecycleMethods(AgentRuntime);
