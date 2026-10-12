// Modified by ZCode Feiyu.
import type { ConfigResult } from "@zcode/adapters/config";
import type { AgentRuntimeConfig } from "@zcode/core";
import type {
  ToolArtifactStorePort,
  ExecutionPort,
  Logger,
  SessionId,
  InputHistoryStorePort,
  ImageProcessorPort,
  PdfDocumentPort,
  McpPort,
  SessionStorePort,
  McpServerConfig,
  LocalSettingStorePort,
  LoggerFactory,
  ProjectId,
} from "@zcode/contracts";
import type { RuntimeModelFactory } from "./provider-registry-model-runtime.js";
import { createDynamicWorkflowRunService } from "./dynamic-workflow-run-service.js";
import { createModelTelemetry } from "@zcode/telemetry";
import { type TraceContext } from "@zcode/contracts";
import { AgentRuntime, PermissionService } from "@zcode/core";

import { resolveZCodeBuiltinPromptCommandInvocation } from "../builtin-prompt-command.js";
import { BUILTIN_WORKFLOW_COMMAND_NAME } from "../builtin-workflow-command.js";
import { resolveZCodeCustomCommandPrompt } from "../custom-command-prompt.js";

import { resolveEffectiveLocale } from "./app-config-options.js";

import { createInputFacade } from "./input-facade.js";

import { type NodeReplBrowserBroker } from "./node-repl-browser-broker.js";

import { createSessionFacade } from "./session-facade.js";

import type { PrepareUserExecutionBoundary, ZCodeAppOptions } from "./types.js";

import { createWorkflowFacade } from "./workflow-facade.js";

// 装配阶段复用同一实例与闭包，不另建运行状态或副作用路径。
export function createAppFacadeAssembly(input: {
  artifactStore: ToolArtifactStorePort;
  runtimeConfig: AgentRuntimeConfig;
  workingDirectory: string;
  runtime: AgentRuntime;
  traceContext: TraceContext;
  options: ZCodeAppOptions;
  executionPort: ExecutionPort;
  logger: Logger;
  sessionId: SessionId;
  inputHistoryStore: InputHistoryStorePort | undefined;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  modelTelemetry: ReturnType<typeof createModelTelemetry>;
  appVersion: string;
  cliStorageRoot: string;
  configResult: ConfigResult;
  imageProcessorPort: ImageProcessorPort;
  pdfDocumentPort: PdfDocumentPort;
  mcpPort: McpPort | undefined;
  modelFactory: RuntimeModelFactory;
  permissionService: PermissionService;
  sessionStore: SessionStorePort;
  storageRoot: string;
  dynamicWorkflowRunPort: ReturnType<typeof createDynamicWorkflowRunService> | undefined;
  configuredMcpServers: Record<string, McpServerConfig>;
  localSettingStore: LocalSettingStorePort | undefined;
  loggerFactory: LoggerFactory;
  ownsExecutionPort: boolean;
  ownsMcpPort: boolean;
  ownedNodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  ownsSessionStore: boolean;
  prepareResume: (submitTraceContext?: TraceContext, abortSignal?: AbortSignal) => Promise<void>;
  projectID: ProjectId;
  untrustedProjectMcpServers: Set<string>;
}) {
  const {
    artifactStore,
    runtimeConfig,
    workingDirectory,
    runtime,
    traceContext,
    options,
    executionPort,
    logger,
    sessionId,
    inputHistoryStore,
    prepareUserExecutionBoundary,
    modelTelemetry,
    appVersion,
    cliStorageRoot,
    configResult,
    imageProcessorPort,
    pdfDocumentPort,
    mcpPort,
    modelFactory,
    permissionService,
    sessionStore,
    storageRoot,
    dynamicWorkflowRunPort,
    configuredMcpServers,
    localSettingStore,
    loggerFactory,
    ownsExecutionPort,
    ownsMcpPort,
    ownedNodeReplBrowserBroker,
    ownsSessionStore,
    prepareResume,
    projectID,
    untrustedProjectMcpServers,
  } = input;

  const inputFacade = createInputFacade({
    artifactStore,
    customCommandPromptResolver: async (text, resolverOptions) => {
      const builtin = resolveZCodeBuiltinPromptCommandInvocation(text, {
        // 动态工作流灰度关闭时内置 `/workflow` 不得展开（DWG-03）。目录侧已经把它从 `/` 面板
        // 剔除，但用户仍可手打命令名，两条路径必须给出同一个结论。独立 CLI 的 TUI 与 headless
        // 按 --workflow-mode 显式取值；缺席（进程内嵌入方）不设门禁，见 runtimeConfig 字段注释。
        dynamicWorkflowEnabled: runtimeConfig.dynamicWorkflowEnabled,
        workingDirectory,
      });
      if (builtin !== undefined) {
        if (builtin.name === BUILTIN_WORKFLOW_COMMAND_NAME) {
          // `/workflow` 的展开处就是 onDemand 会话的激活点（launch.md「On demand: activation」）：
          // 它先于 executeTurn，本轮首个模型请求就带着十个工具。alwaysOn / 已激活会话里是 no-op。
          // 问的是 runtime 而不是闭包里的 runtimeConfig——构造时 config 被拷贝，闭包看不到翻转。
          await runtime?.activateDynamicWorkflowTools({
            source: "command",
            traceContext: resolverOptions?.traceContext ?? traceContext,
          });
        }
        return builtin.prompt;
      }
      return await resolveZCodeCustomCommandPrompt(text, {
        env: options.env,
        executionPort,
        logger,
        projectConfigPath: options.projectConfigPath,
        sessionId,
        signal: resolverOptions?.abortSignal,
        skipUserConfig: options.skipUserConfig,
        traceContext: resolverOptions?.traceContext ?? traceContext,
        userConfigPath: options.userConfigPath,
        workingDirectory,
      });
    },
    inputHistoryStore,
    logger,
    prepareUserExecutionBoundary,
    runtime,
    sessionId,
    traceContext,
  });
  const workflowFacade = createWorkflowFacade({
    agentTelemetry: modelTelemetry.agentExecution,
    appOptions: options,
    appVersion,
    artifactStore,
    cliStorageRoot,
    configResult,
    eventSink: options.eventSink,
    imageProcessorPort,
    pdfDocumentPort,
    logger,
    mcpPort,
    modelFactory,
    permissionService,
    prepareUserExecutionBoundary,
    runtime,
    runtimeConfig,
    sessionId,
    sessionStore,
    storageRoot,
    traceContext,
    workingDirectory,
  });
  const sessionFacade = createSessionFacade({
    // App 关闭时停下本会话拥有的 dwf run：
    // 引擎活在本 App 的闭包里，关掉 App 而不停它，journal 行会停在 running 等下一次孤儿收敛。
    ...(dynamicWorkflowRunPort === undefined
      ? {}
      : { closeDynamicWorkflowRuns: () => dynamicWorkflowRunPort.close() }),
    configResult,
    configuredMcpServers,
    ...(options.configuredDefaultModelSelection
      ? {
          configuredDefaultModelSelection: options.configuredDefaultModelSelection,
        }
      : {}),
    executionPort,
    localSettingStore,
    logger,
    loggerFactory,
    mcpPort,
    ownsExecutionPort,
    ownsMcpPort,
    closeNodeReplBrowserBroker: async () => {
      await ownedNodeReplBrowserBroker?.close();
    },
    ownsSessionStore,
    prepareUserExecutionBoundary,
    prepareResume,
    projectID,
    providerRegistry: options.providerRegistry,
    resolveUiLocale: (locale) => resolveEffectiveLocale(locale, options),
    runtime,
    sessionId,
    sessionStore,
    traceContext,
    untrustedProjectMcpServers,
    workingDirectory,
  });

  const closeSession = sessionFacade.close;
  return { sessionFacade, closeSession, workflowFacade, inputFacade };
}
