// Modified by ZCode Feiyu.
import type {
  BackgroundTaskCancelResult,
  CollaborationMode,
  GoalStatus,
  InputHistoryEntry,
  InputHistoryKind,
  McpListResourceTemplatesResult,
  McpListResourcesResult,
  McpReadResourceResult,
  McpServerStatus,
  McpToolCallResult,
  ModelSelection,
  PluginLoadOutcome,
  PluginReferenceCatalog,
  SessionGoal,
  SessionId,
  SkillLoadOutcome,
  SupportedLocale,
  TodoItem,
  ToolArtifactReadResult,
  TraceContext,
  TurnInputIntentMetadata,
  UiThemePreference,
} from "@zcode/contracts";
import type {
  AgentRuntime,
  McpAppProvidedToolDefinition,
  McpAppProvidedToolExecutor,
  TurnResult,
} from "@zcode/core";
import type { BackgroundBashOutputResult, ZCodeModelOption } from "@zcode/shared";
import type { McpAppsToolVisibility } from "@zcode/shared/mcp-apps";

import type { SessionTranscriptMessage } from "../session-transcript.js";

import type { WorkspaceHookReviewCommandResult } from "./workspace-hook-review-controller.js";
import type {
  RespondWorkspaceHookReviewInput,
  ToggleWorkspaceHookReviewItemInput,
  RevokeWorkspaceHookTrustInput,
  SubmitPromptOptions,
  PromptInput,
  ZCodePluginSetResult,
  ZCodePluginUninstallResult,
} from "./types.js";
// 将公开应用合同按功能分组；不改变字段或运行状态。
export interface ZCodeAppSessionSurface {
  readonly sessionId: SessionId;

  readonly traceId: string;

  readonly runtime: AgentRuntime;

  respondWorkspaceHookReview(
    input: RespondWorkspaceHookReviewInput,
  ): Promise<WorkspaceHookReviewCommandResult>;

  toggleWorkspaceHookReviewItem(
    input: ToggleWorkspaceHookReviewItemInput,
  ): Promise<WorkspaceHookReviewCommandResult & { request?: unknown }>;

  revokeWorkspaceHookTrust(
    input: RevokeWorkspaceHookTrustInput,
  ): Promise<WorkspaceHookReviewCommandResult>;

  /** 软门禁:按需开审核 flow,无 pending 项时为安全 no-op */
  requestWorkspaceHookReview(input: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult>;

  /**
   * Trust store 落盘后本 session 的 coordinator
   * 内存镜像不会自动更新（per-session，仅创建时 load 一次）。Settings 无 task 的
   * pretrust 授权成功后，server 会按 workspace 逐个调用本方法，把文件重载进
   * coordinator 并重发 admission 状态，否则已信任 Hook 继续被拒、banner 不刷新。
   */
  reloadWorkspaceHookTrust(): Promise<void>;

  close?(): Promise<void>;

  getMode(): CollaborationMode;

  getModel(): string;

  /** current-only 协议快照精确读取当前 Registry 模型，避免枚举整个目录。 */
  getCurrentModelOption?(): ZCodeModelOption | undefined;

  /** 只读 Registry 元数据；不要求选项完整，也不绑定执行模型。 */
  getModelOption?(selection: ModelSelection): ZCodeModelOption | undefined;

  getLocale(): SupportedLocale;

  getTheme(): UiThemePreference;

  getDefaultThoughtLevel(): string | undefined;

  getThoughtLevel(): string | undefined;

  loadSessionTranscript(): Promise<SessionTranscriptMessage[]>;

  readSubagents(input?: {
    endedCursor?: string;
    endedLimit?: number;
  }): Promise<import("@zcode/shared").ZCodeSessionSubagentsResult>;

  readSubagentTranscript(
    childSessionId: string,
  ): Promise<import("./subagent-observation.js").SubagentTranscriptSnapshot>;

  readTodos(): Promise<TodoItem[]>;

  readTarget(): Promise<SessionGoal | null>;

  setCustomSessionTitle(input: { title: string; traceContext?: TraceContext }): Promise<void>;

  readToolResultArtifact(uri: string): Promise<ToolArtifactReadResult>;

  /** chunk transaction commit 后把完整二进制原子寄存到 session artifact store。 */
  writePromptAttachment(input: {
    fileName: string;
    mime: string;
    bytes: Uint8Array;
  }): Promise<{ ref: string }>;

  /** 已发送 image/video 预览：在拥有 session 的 runtime 内读取 artifact 或实际路径。 */
  readPromptAttachment(input: {
    ref: string;
    mime: string;
    maxBytes: number;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ bytes: Uint8Array; mediaType: string }>;

  /** Share 选择阶段只读 userInput 附件元数据；不读取完整内容。 */
  statPromptAttachment?(input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ totalBytes: number; mediaType: string; mtimeMs?: number }>;

  /** Desktop local 已发送视频：解析 artifact-first 本地播放源；否则保持分片读取。 */
  resolvePromptAttachmentPreviewSource(input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ kind: "local_path"; path: string; mediaType: string } | { kind: "chunked" }>;

  setTarget(input: {
    objective: string;
    /** 用户提交的原始 goal 命令；target 仍只存 objective，聊天行按该文本展示。 */
    displayText?: string;
    status?: GoalStatus;
    tokenBudget?: number | null;
    intent?: TurnInputIntentMetadata;
  }): Promise<SessionGoal>;

  updateTargetStatus(status: GoalStatus): Promise<SessionGoal | null>;

  clearTarget(): Promise<boolean>;

  continueActiveTarget(options?: SubmitPromptOptions): Promise<TurnResult | null>;

  recordInputHistory(
    input: PromptInput,
    kind?: InputHistoryKind,
  ): Promise<InputHistoryEntry | null>;

  recallPreviousInputHistory(skip?: number): Promise<InputHistoryEntry | null>;

  listModels(): ZCodeModelOption[];

  listThoughtLevels(): string[];

  listPlugins(): Promise<PluginLoadOutcome>;

  setPluginEnabled(plugin: string, enabled: boolean): Promise<ZCodePluginSetResult>;

  uninstallPlugin(plugin: string): Promise<ZCodePluginUninstallResult>;

  /**
   * Session 冻结的 Plugin 身份 catalog。
   * 在 App 创建时由 resolveStartupPlugins 结果构建一次，之后只读；
   * `plugins/referenceCatalog` 带 sessionId 时以此为 session authority。
   */
  getPluginReferenceCatalog(): PluginReferenceCatalog;

  /** 当前 Session 的 AgentRuntime Skill 发现快照；冷恢复重建 runtime 后重新发现。 */
  getSkillCatalog(): Promise<SkillLoadOutcome>;

  listMcpServers(): Promise<Record<string, McpServerStatus>>;

  connectMcpServer(name: string): Promise<McpServerStatus>;

  /**
   * 插件 UI：UI 发起的资源读取与工具调用，
   * 走 session 自己的 mcpPort；归属校验在 mcp-ui 处理器完成，这里不重复。
   */
  readMcpResource(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpReadResourceResult>;

  onMcpAppConnectionInvalidated(serverName: string, listener: () => void): () => void;

  getMcpAppConnectionSnapshot(serverName: string): { identity: string; generation: number } | null;

  callMcpToolForUi(
    serverName: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    options?: { signal?: AbortSignal },
  ): Promise<McpToolCallResult>;

  /**
   * 按 tools/list 的 descriptor 给出工具可见性；工具不存在返回 null。
   * mcp-ui 用它拒绝 model-only 工具的 UI 调用。
   */
  getMcpToolVisibility(
    serverName: string,
    toolName: string,
  ): Promise<readonly McpAppsToolVisibility[] | null>;

  /**
   * App-Provided Tools：用给定集合整体替换本会话的 App 工具，失效工具缓存让下一次模型请求可见。
   * 与非 App 工具重名的定义跳过。返回实际登记的模型侧名字。
   */
  replaceMcpAppProvidedTools(
    definitions: readonly McpAppProvidedToolDefinition[],
    execute: McpAppProvidedToolExecutor,
  ): string[];

  /** 页面发起的 resources/list、resources/templates/list 与订阅（订阅者身份由调用方给出）。 */
  listMcpResourcesForUi(
    serverName: string,
    cursor?: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpListResourcesResult>;

  listMcpResourceTemplatesForUi(
    serverName: string,
    cursor?: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpListResourceTemplatesResult>;

  subscribeMcpResourceForUi(
    serverName: string,
    uri: string,
    subscriberKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;

  unsubscribeMcpResourceForUi(
    serverName: string,
    uri: string,
    subscriberKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;

  /** 会话关闭：清掉本会话（subscriberKey 前缀）的全部订阅。 */
  unsubscribeMcpResourcesForUi(subscriberKeyPrefix: string): Promise<number>;

  /** 插件页面发起的 resources/read；与 readMcpResource 同一端口，独立入口便于审计与限流。 */
  readMcpResourceForUi(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpReadResourceResult>;

  readBackgroundBashOutput(workId: string, sessionId?: string): Promise<BackgroundBashOutputResult>;

  cancelBackgroundTask?(
    taskId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<BackgroundTaskCancelResult>;
}
