// Modified by ZCode Feiyu.
import { createAppSkillFactory } from "./app-skill-factory.js";
import { createAppWorkspaceHookSecurity } from "./app-workspace-hook-security.js";
import { createAppInitialization } from "./app-initialization.js";
import { createAppRuntimeConstruction } from "./app-runtime-construction.js";
import { createAppFacadeAssembly } from "./app-facade-assembly.js";
import { createAppResumeLifecycle } from "./app-resume-lifecycle.js";
import { createAppRuntimePorts } from "./app-runtime-ports.js";
import { createAppPluginFoundation } from "./app-plugin-foundation.js";
import { createAppWorkflowPorts } from "./app-workflow-ports.js";
import { createAppReturnSurface } from "./app-return-surface.js";

import { type TraceContext } from "@zcode/contracts";
import { AgentRuntime, PermissionService, buildPluginReferenceCatalog } from "@zcode/core";

import { scheduleStartupLogRetentionCleanup } from "../log-retention.js";
import { createRuntimeAiSdkModelExecutionConfig } from "../model-config.js";
import { createModelAdapter } from "../model-factory.js";

import { createComputerUseRefresh } from "./computer-use-refresh.js";

import {
  createNodeReplBrowserBroker,
  injectNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./node-repl-browser-broker.js";

import { ApiProviderModelRuntime } from "./provider-registry-model-runtime.js";
import { runtimeConfigLogContext } from "./runtime-config.js";

import { createScriptWorkflowBridge } from "./script-workflow-methods.js";

import { asInputHistoryStore } from "./session-store.js";
import {
  completeAppStartup,
  debugRuntimeConfigResolved,
  markMcpAdapterInitialized,
  markRuntimeConstructed,
} from "./startup-marks.js";
import type { ZCodeApp, ZCodeAppOptions } from "./types.js";

import { getWorkflowConcurrencyGovernor } from "./workflow-concurrency-governor.js";

export async function createZCodeApp(options: ZCodeAppOptions): Promise<ZCodeApp> {
  if (!options?.providerRegistry) {
    throw new Error("createZCodeApp requires a Provider Registry");
  }
  const {
    configResult,
    traceContext,
    logger,
    workingDirectory,
    startupTimer,
    sessionId,
    appVersion,
    modelLogger,
    modelTelemetry,
    loggerFactory,
  } = createAppInitialization({ options });
  let nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let ownedNodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let providerModelRuntime: ApiProviderModelRuntime | undefined;
  try {
    const {
      options: resolvedAppOptions,
      pluginRuntimeFeatures,
      runtimeConfig,
      configuredMcpServers: initialConfiguredMcpServers,
      pluginOutcome,
      sessionStore,
      storageRoot,
      cliStorageRoot,
      modelIoDir,
      bundledSkillRoots,
      pluginTemplates,
      localSettingStore,
      ownsSessionStore,
      projectID,
      untrustedProjectMcpServers,
    } = await createAppPluginFoundation({
      configResult,
      options,
      traceContext,
      logger,
      workingDirectory,
      startupTimer,
      sessionId,
    });
    let configuredMcpServers = initialConfiguredMcpServers;
    options = resolvedAppOptions;
    const browserControlPort = options.browserControlPort;
    if (
      browserControlPort &&
      pluginRuntimeFeatures.browserUse === true &&
      runtimeConfig.mcp?.servers?.node_repl?.type === "stdio"
    ) {
      nodeReplBrowserBroker =
        options.nodeReplBrowserBroker ??
        (ownedNodeReplBrowserBroker = createNodeReplBrowserBroker({
          browserControlPort,
          logger,
          platform: options.platform,
        }));
      configuredMcpServers = injectNodeReplBrowserBroker(
        configuredMcpServers,
        nodeReplBrowserBroker,
      );
      runtimeConfig.mcp = {
        ...runtimeConfig.mcp,
        servers: injectNodeReplBrowserBroker(
          runtimeConfig.mcp.servers ?? {},
          nodeReplBrowserBroker,
        ),
      };
    }
    startupTimer.mark("ZCode runtime configuration resolved", {
      context: runtimeConfigLogContext(runtimeConfig, workingDirectory),
      event: "bootstrap.app.startup.runtime_config.completed",
      stage: "resolve_runtime_config",
    });
    // Plugin 对话引用：身份 catalog 在 App（Session runtime）
    // 普通插件创建时冻结；官方电脑控制在合法任务边界定向刷新，不重建会话历史。
    let pluginReferenceCatalog = buildPluginReferenceCatalog(pluginOutcome.plugins);
    runtimeConfig.pluginReferenceCatalog = pluginReferenceCatalog;
    let runtime: AgentRuntime | undefined;
    let refreshComputerUseCapabilities: ((trace: TraceContext) => Promise<void>) | undefined;
    const { workspaceHookRuntimeSecurity } = createAppWorkspaceHookSecurity({
      appVersion,
      logger,
      options,
      configResult,
      runtimeConfig,
      sessionId,
      workingDirectory,
      readRuntime: () => runtime,
      traceContext,
    });
    const permissionService = new PermissionService({
      allowedTools: new Set(configResult.config.permission.allowedTools),
      autoApproveHighRisk: configResult.config.permission.autoApproveHighRisk,
      disallowedTools: new Set(configResult.config.permission.disallowedTools),
      allowMediumRiskInAutoMode: configResult.config.permission.allowMediumRiskInAuto,
    });
    const inputHistoryStore = options.inputHistoryStore ?? asInputHistoryStore(sessionStore);
    const {
      providerEndpointRoutingPort,
      artifactStore,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      mcpPort,
      executionPort,
      sessionMailboxPort,
      ownsExecutionPort,
      ownsMcpPort,
    } = createAppRuntimePorts({
      options,
      storageRoot,
      cliStorageRoot,
      startupTimer,
      runtimeConfig,
      workingDirectory,
      appVersion,
      logger,
      configResult,
    });
    markMcpAdapterInitialized({
      configuredMcpServers,
      hasInjectedMcpPort: options.mcpPort !== undefined,
      mcpEnabled: runtimeConfig.mcp?.enabled !== false,
      startupTimer,
      trustedMcpServerCount: Object.keys(runtimeConfig.mcp?.servers ?? {}).length,
    });
    debugRuntimeConfigResolved({
      configResult,
      logger,
      runtimeConfig,
    });
    const getRuntime = (): AgentRuntime => {
      if (!runtime) throw new Error("ZCode runtime is not initialized yet.");
      return runtime;
    };
    const { prepareUserExecutionBoundary, prepareResume, resumeFromStore } =
      createAppResumeLifecycle({
        options,
        getRuntime,
        sessionStore,
        sessionId,
        logger,
        traceContext,
        readComputerUseCapabilities: () => refreshComputerUseCapabilities,
      });

    const modelExecutionConfig = createRuntimeAiSdkModelExecutionConfig(options.env, {
      appVersion,
      endpointRoutingPort: providerEndpointRoutingPort,
      network: configResult.config.network,
      sourceTitle: options.sourceTitle,
    });
    const modelAdapter =
      options.modelAdapter ??
      createModelAdapter({
        env: options.env,
        logger: modelLogger,
        modelIoDir,
        modelIoFullRetentionEnabled: options.modelIoFullRetentionEnabled,
        executionConfig: modelExecutionConfig,
        statusSink: modelTelemetry.statusSink,
        streamIdleTimeoutMs: configResult.config.modelStream.idleTimeoutMs,
      });
    if (options.modelAdapter && modelTelemetry.statusSink) {
      modelAdapter.addStatusSink(modelTelemetry.statusSink);
    }
    // 进程级并发治理器：run service 拿它的窄端口给
    // driver（每个 actor runtime 一个请求级准入端口）；主 runtime 挂它的 observer（下面 deps）——
    // 不排队、不看冷却，但计入在飞并喂信号。进程级单例——配额本就在账号上，不按会话分。
    // 不再经 adapter 级 addStatusSink 喂信号：同一事件只能沿 ticket 喂一次。
    const workflowConcurrencyGovernor = getWorkflowConcurrencyGovernor();
    modelAdapter.setModelIoFullRetentionEnabled(options.modelIoFullRetentionEnabled ?? false);
    providerModelRuntime = new ApiProviderModelRuntime({
      registry: options.providerRegistry,
      modelAdapter,
    });
    providerModelRuntime.start();
    // model factory 提前到三条 workflow child 装配线之前构造：script workflow bridge、dwf actor
    // runtime 与 expert workflow facade 都**共享**父会话这一份 factory——Registry 视图更新后
    // 新建的 Model 才看得到，child 不各自冻结一份。
    const modelFactory = providerModelRuntime.modelFactory;
    const scriptWorkflowFacade = createScriptWorkflowBridge({
      agentTelemetry: modelTelemetry.agentExecution,
      appOptions: options,
      appVersion,
      artifactStore,
      configResult,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      logger,
      mcpPort,
      modelFactory,
      permissionService,
      pluginSkillRoots: pluginOutcome.skillRoots,
      prepareUserExecutionBoundary,
      getRuntime,
      runtimeConfig,
      sessionId,
      sessionStore,
      storageRoot,
      traceContext,
      workingDirectory,
    });
    const { dynamicWorkflowRunPort, dynamicWorkflowSnippetPort, modelCatalogPort } =
      createAppWorkflowPorts({
        sessionStore,
        logger,
        workflowConcurrencyGovernor,
        getRuntime,
        modelTelemetry,
        options,
        appVersion,
        artifactStore,
        configResult,
        fileSystemPort,
        httpClientPort,
        imageProcessorPort,
        mcpPort,
        modelFactory,
        permissionService,
        pluginOutcome,
        runtimeConfig,
        sessionId,
        storageRoot,
        workingDirectory,
        browserControlPort,
        traceContext,
        executionPort,
      });
    const { createSessionSkillPort } = createAppSkillFactory({
      configResult,
      options,
      bundledSkillRoots,
      runtimeConfig,
    });
    const { createdRuntime } = createAppRuntimeConstruction({
      sessionId,
      runtimeConfig,
      options,
      logger,
      pluginOutcome,
      pluginTemplates,
      modelTelemetry,
      workflowConcurrencyGovernor,
      sessionStore,
      sessionMailboxPort,
      executionPort,
      workspaceHookRuntimeSecurity,
      browserControlPort,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      artifactStore,
      createSessionSkillPort,
      mcpPort,
      modelFactory,
      modelIoDir,
      permissionService,
      scriptWorkflowFacade,
      dynamicWorkflowRunPort,
      dynamicWorkflowSnippetPort,
      modelCatalogPort,
      appVersion,
      traceContext,
    });
    runtime = createdRuntime;
    await runtime.recoverProjectMemory();
    refreshComputerUseCapabilities = createComputerUseRefresh({
      initial: pluginOutcome,
      options,
      workingDirectory,
      getRuntime,
      logger,
      createSkillPort: createSessionSkillPort,
      decorateServers: (servers) =>
        nodeReplBrowserBroker
          ? injectNodeReplBrowserBroker(servers, nodeReplBrowserBroker)
          : servers,
      onApplied: (server, catalog) => {
        if (server) configuredMcpServers.node_repl = server;
        else delete configuredMcpServers.node_repl;
        pluginReferenceCatalog = catalog;
      },
    });
    markRuntimeConstructed({
      hasInjectedModelAdapter: options.modelAdapter !== undefined,
      sessionId,
      startupTimer,
    });
    completeAppStartup({
      sessionId,
      startupTimer,
      workingDirectory,
    });
    scheduleStartupLogRetentionCleanup(loggerFactory, logger);
    const { sessionFacade, closeSession, workflowFacade, inputFacade } = createAppFacadeAssembly({
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
    });
    return createAppReturnSurface({
      sessionId,
      traceContext,
      runtime,
      workspaceHookRuntimeSecurity,
      modelAdapter,
      artifactStore,
      sessionStore,
      fileSystemPort,
      sessionFacade,
      closeSession,
      providerModelRuntime,
      modelTelemetry,
      workflowFacade,
      scriptWorkflowFacade,
      dynamicWorkflowRunPort,
      getRuntime,
      prepareUserExecutionBoundary,
      configResult,
      options,
      workingDirectory,
      readPluginReferenceCatalog: () => pluginReferenceCatalog,
      resumeFromStore,
      inputFacade,
    });
  } catch (error) {
    providerModelRuntime?.dispose();
    void modelTelemetry.shutdown().catch(() => undefined);
    void ownedNodeReplBrowserBroker?.close();
    startupTimer.fail("ZCode app startup failed", error, {
      context: { sessionId, workingDirectory },
      event: "bootstrap.app.startup.failed",
      stage: "total",
    });
    throw error;
  }
}
