// Modified by ZCode Feiyu.
import type { ZCodeAppSessionSurface } from "./app-session-surface.js";
import type { ZCodeAppFeatureSurface } from "./app-feature-surface.js";
import type { AiSdkModelAdapter } from "@zcode/adapters/model";
import type {
  AgentTelemetryRuntimeOwner,
  AutomationPort,
  BrowserControlPort,
  ContextSourcePort,
  ExecutionPort,
  ExecutionShellSelection,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  InputDelivery,
  InputHistoryStorePort,
  LoggerFactory,
  McpPort,
  MessageWithParts,
  ModelSelection,
  OffPeakPort,
  PdfDocumentPort,
  PermissionBrokerPort,
  PluginMetadata,
  ProviderEndpointRoutingPort,
  QueryId,
  SessionEvent,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionMailboxPort,
  SessionStorePort,
  SkillPort,
  SupportedLocale,
  TaskMessagePort,
  ToolArtifactStorePort,
  TopicResourcePort,
  TraceContext,
  TurnId,
  TurnInputIntentMetadata,
  TurnSteerResult,
  UiLocale,
  WorkflowEvent,
  WorkspaceHookPolicy,
} from "@zcode/contracts";
import type {
  AgentRuntimeConfig,
  ExecuteTurnOptions,
  ModelExecutionContext,
  PresentationSurface,
  ProviderRuntimeHeadersPort,
  TurnAttachment,
  TurnResult,
  WorkflowAgentRunner,
  WorkspaceHookPolicyProvider,
  WorkspaceHookReviewTarget,
} from "@zcode/core";
import type { SubagentRuntimeConfig, ZCodeToolExecResource } from "@zcode/shared";

import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
import type {
  WorkspaceHookReviewDecision,
  WorkspaceHookTrustRevokeTarget,
} from "@zcode/shared/zcode-protocol-v4";
import type { ModelProviderSourceTitle } from "../model-config.js";
import type { ZCodeInstalledPluginData } from "../plugins.js";

import type { NodeReplBrowserBroker } from "./node-repl-browser-broker.js";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";

export type { ZCodeModelOption } from "@zcode/shared";

export interface WorkspaceHookReviewHostContext {
  taskId: string;
  runId: string;
  workspaceLabel: string;
  remoteSessionId?: string;
}

export type RespondWorkspaceHookReviewInput = WorkspaceHookReviewTarget & {
  decision: WorkspaceHookReviewDecision;
};

export type ToggleWorkspaceHookReviewItemInput = WorkspaceHookReviewTarget & {
  reviewItemId: string;
  enabled: boolean;
};

export type RevokeWorkspaceHookTrustInput =
  | (WorkspaceHookReviewTarget & { reviewItemIds: string[] })
  | WorkspaceHookTrustRevokeTarget;

/** 新 Session 可使用 Environment 默认选择；恢复 Session 允许保持未绑定，不补默认模型。 */
export type ZCodeAppRuntimeConfigInput = AgentRuntimeConfig;

export interface ZCodeAppOptions {
  sessionId?: SessionId;
  resume?: boolean;
  version?: string;
  traceContext?: TraceContext;
  runtimeConfig?: ZCodeAppRuntimeConfigInput;
  /**
   * stdio 协议模式的 agent 进程由 Electron host 拉起，模型服务需要看到 electron 来源。
   * 普通 CLI 不传，继续使用 cli 默认值。
   */
  sourceTitle?: ModelProviderSourceTitle;
  /** 本地 Host 源文档读取；无此能力时保持启动期配置。 */
  readSubagentRuntimeConfig?: (input: {
    signal: AbortSignal;
    traceContext: TraceContext;
  }) => Promise<SubagentRuntimeConfig>;
  eventStore?: SessionEventStorePort;
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  inputHistoryStore?: InputHistoryStorePort;
  modelAdapter?: AiSdkModelAdapter;
  /** Worker 进程拥有的 Registry；App 只借用，不负责释放。 */
  providerRegistry: ProviderRegistryModelSource;
  resolveEffectiveModelSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
  /** 新 Session 使用的 Environment 默认选择；仅在没有显式 runtime modelSelection 时参与初始化。 */
  configuredDefaultModelSelection?: ModelSelection;
  modelIoFullRetentionEnabled?: boolean;
  /** 同进程嵌入宿主可注入完整的 borrowed 进程级 Owner；Endpoint 配置不得覆盖它。 */
  telemetryOwner?: AgentTelemetryRuntimeOwner;
  providerEndpointRoutingPort?: ProviderEndpointRoutingPort;
  /**
   * provider runtime headers 端口：主 runtime 每次调用报自己的会话；child runtime 一律向父
   * runtime 取派生实例。
   */
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  loggerFactory?: LoggerFactory;
  officialPluginRoots?: string[];
  pluginStorageRoot?: string;
  executionPort?: ExecutionPort;
  /** 资源遥测旁路；由协议宿主注入，主任务和 workflow 的执行适配器共用。 */
  onToolExecResource?: (sample: ZCodeToolExecResource) => void;
  /** browser-use 控制端口；注入后 node_repl 的 agent.browsers.* 可用。缺省则不可用。 */
  browserControlPort?: BrowserControlPort;
  /** Desktop local Host 提供的顶层任务间消息端口。 */
  taskMessagePort?: TaskMessagePort;
  imageGenerationPort?: import("@zcode/contracts").ImageGenerationPort;
  /** 可由协议宿主注入的进程级 node_repl Browser broker；缺省时 app 自建并拥有。 */
  nodeReplBrowserBroker?: NodeReplBrowserBroker;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  artifactStore?: ToolArtifactStorePort;
  contextSourcePort?: ContextSourcePort;
  /** 仅协议宿主注入；普通 CLI 不加载内置 visualize 技能。 */
  includeVisualize?: boolean;
  skillPort?: SkillPort;
  mcpPort?: McpPort;
  /** 由宿主提供 per-app lease；产出的端口归 app 所有。 */
  mcpPortFactory?: (input: { workingDirectory?: string }) => McpPort;
  permissionBroker?: PermissionBrokerPort;
  eventSink?: SessionEventSink;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | string;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  uiDetectedLocale?: string | null;
  uiLocale?: UiLocale;
  onWorkflowEvent?: (event: WorkflowEvent) => void | Promise<void>;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  topicResourcePort?: TopicResourcePort;
  /** 首次真实用户执行或 cold-resume fallback 时解析一次，之后由 app 生命周期缓存。 */
  resolveInitialBashShellSelection?: () => Promise<ExecutionShellSelection | undefined>;
  /** Trusted embedder policy; workspace/project files cannot populate this field. */
  workspaceHookPolicy?: WorkspaceHookPolicy;
  /** Protocol Host-owned provider shared by session Runtime and no-session Settings pretrust. */
  workspaceHookPolicyProvider?: WorkspaceHookPolicyProvider;
  /** Rollout gate; false keeps project Hooks hard-blocked and does not read Trust records. */
  workspaceHookTrustEnabled?: boolean;
  /** Presence means this owner Host supports the dedicated Workspace Hook review route. */
  workspaceHookReviewHost?: WorkspaceHookReviewHostContext;
}

export interface SubmitPromptOptionsBase {
  skipSuggestedPrompt?: boolean;
  traceContext?: TraceContext;
  abortSignal?: AbortSignal;
  inputId?: string;
  queryId?: QueryId;
  intent?: TurnInputIntentMetadata;
  sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  /** 内部 admission 观察点：只表示 runtime sink 看见 TurnStarted，不代表 projection 已 apply。 */
  onTurnStartedObserved?: (event: SessionEvent) => void;
  /** 仅当前 turn 从 provider 工具列表移除；不会永久改变 session runtime。 */
  toolDisallowlist?: readonly string[];
  /** App 只读提供的 provider-only IAB 环境状态，不进入 UI transcript。 */
  browserAmbientContext?: ExecuteTurnOptions["browserAmbientContext"];
  /** 标准 Selection 的单次执行约束；不进入 Session Selection 或持久化。 */
  modelExecution?: ModelExecutionContext;
}

export type SubmitPromptOptions = SubmitPromptOptionsBase &
  import("@zcode/contracts").TurnBackgroundAttribution;

export type PrepareUserExecutionBoundary = (
  options?: Pick<SubmitPromptOptions, "abortSignal" | "traceContext">,
) => Promise<void>;

export interface SteerTurnOptions {
  inputId?: string;
  queryId?: QueryId;
  expectedTurnId?: TurnId;
  commandKind?: "sendText" | "sendGoalCommand" | "compact";
  /** 投递语义：queue=消费时切新轮；guide=内联当前轮。缺省 queue。 */
  delivery?: "guide" | "queue";
  intent?: TurnInputIntentMetadata;
  attachments?: TurnAttachment[];
  /** 当前 queued/guide 输入消费时不向 provider 暴露的工具名。 */
  toolDisallowlist?: readonly string[];
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  traceContext?: TraceContext;
}

export type SendInputOptions = SubmitPromptOptions & {
  inputId?: string;
  /** 可信消费入口确定的呈现标记；不改变原始用户内容或调度语义。 */
  inputPresentation?: ExecuteTurnOptions["inputPresentation"];
  delivery?: InputDelivery;
  /** sendText 的产品 guide/queue 意图；是否 busy 仍由 Core admission 判断。 */
  queueDelivery?: "guide" | "queue";
  /** Highspeed 等必须延后到独立 turn 的输入，即使 admission 时已转为空闲也保持排队。 */
  requireQueue?: boolean;
  requireIdle?: boolean;
  expectedTurnId?: TurnId;
  commandKind?: "sendText" | "sendGoalCommand" | "compact";
};

export interface UserPromptInput {
  text: string;
  attachments?: TurnAttachment[];
}

export type PromptInput = string | UserPromptInput;

export type SendInputResult =
  | {
      /** Core 已完成 admission；completion 只供生命周期清理，不是 ACK 等待边界。 */
      completion: Promise<TurnResult>;
      kind: "started_turn";
      turnId: TurnId;
    }
  | TurnSteerResult;

export interface ResumeOptions {
  abortSignal?: AbortSignal;
  traceContext?: TraceContext;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  /** 同一次冷恢复的调用级已物化结果；不进入 app 生命周期缓存。compact 修补后须按返回值刷新。 */
  persistedMessages?: MessageWithParts[];
}

export interface ZCodePluginSetResult {
  enabled: boolean;
  path: string;
  plugin: PluginMetadata;
}

export interface ZCodePluginUninstallResult {
  // null 表示该 plugin id 当前未安装（幂等 no-op），调用方据此提示"未安装"。
  removed: ZCodeInstalledPluginData | null;
}

export interface SetLocaleResult {
  configPath: string;
  locale: SupportedLocale;
  previousLocale: SupportedLocale;
  requestedLocale: UiLocale;
  traceId: TraceContext["traceId"];
}

export interface ZCodeApp extends ZCodeAppSessionSurface, ZCodeAppFeatureSurface {}

export interface ResolveLatestSessionOptions {
  directory: string;
  env?: NodeJS.ProcessEnv;
  sessionStore?: SessionStorePort;
}

export interface RunZCodeProtocolAgentOptions {
  /** 入口拥有退出时限；bootstrap 只编排取消和资源清理，不直接退出进程。 */
  lifecycle?: {
    readonly signal: AbortSignal;
    readonly deadlineAt: number | undefined;
    requestShutdown(error?: Error): void;
  };
  /** Desktop 内部命令：只运行原存储准备并退出。 */
  prepareStorageOnly?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  presentationSurface?: PresentationSurface;
  providerEndpointRoutingPort?: ProviderEndpointRoutingPort;
  version?: string;
}

export interface ListZCodeSessionsOptions {
  directory?: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  sessionStore?: SessionStorePort;
}

export type { WorkflowAgentRunner };
