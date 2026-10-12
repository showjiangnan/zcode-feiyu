// Modified by ZCode Feiyu.
import { loadPluginAgentTemplates } from "../subagents.js";
import type { AgentRuntimeConfig } from "@zcode/core";
import type {
  ToolArtifactStorePort,
  ExecutionPort,
  Logger,
  SessionId,
  ImageProcessorPort,
  PdfDocumentPort,
  McpPort,
  SessionStorePort,
  FileSystemPort,
  HttpClientPort,
  PluginLoadOutcome,
  BrowserControlPort,
  SessionMailboxPort,
  SkillPort,
  DynamicWorkflowSnippetPort,
  ModelCatalogPort,
} from "@zcode/contracts";
import type { RuntimeModelFactory } from "./provider-registry-model-runtime.js";
import type { WorkspaceHookRuntimeSecurity } from "./workspace-hook-trust.js";
import { getWorkflowConcurrencyGovernor } from "./workflow-concurrency-governor.js";
import { createScriptWorkflowBridge } from "./script-workflow-methods.js";
import { createDynamicWorkflowRunService } from "./dynamic-workflow-run-service.js";
import { createModelTelemetry } from "@zcode/telemetry";
import { createNodeContextSourceAdapter } from "@zcode/adapters/context";

import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import { type SkillRoot, type TraceContext } from "@zcode/contracts";
import { AgentRuntime, PermissionService, normalizeAgentProfiles } from "@zcode/core";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";

import { subagentProfilesFromSnapshot } from "../subagent-runtime-config.js";

import { resolvePluginAgentProfiles } from "../subagents.js";

import type { ZCodeAppOptions } from "./types.js";

// 装配阶段复用同一实例与闭包，不另建运行状态或副作用路径。
export function createAppRuntimeConstruction(input: {
  sessionId: SessionId;
  runtimeConfig: AgentRuntimeConfig;
  options: ZCodeAppOptions;
  logger: Logger;
  pluginOutcome: PluginLoadOutcome;
  pluginTemplates: ReturnType<typeof loadPluginAgentTemplates>;
  modelTelemetry: ReturnType<typeof createModelTelemetry>;
  workflowConcurrencyGovernor: ReturnType<typeof getWorkflowConcurrencyGovernor>;
  sessionStore: SessionStorePort;
  sessionMailboxPort: SessionMailboxPort | undefined;
  executionPort: ExecutionPort;
  workspaceHookRuntimeSecurity: WorkspaceHookRuntimeSecurity | undefined;
  browserControlPort: BrowserControlPort | undefined;
  fileSystemPort: FileSystemPort;
  httpClientPort: HttpClientPort;
  imageProcessorPort: ImageProcessorPort;
  pdfDocumentPort: PdfDocumentPort;
  artifactStore: ToolArtifactStorePort;
  createSessionSkillPort: (roots: SkillRoot[]) => SkillPort | undefined;
  mcpPort: McpPort | undefined;
  modelFactory: RuntimeModelFactory;
  modelIoDir: string;
  permissionService: PermissionService;
  scriptWorkflowFacade: ReturnType<typeof createScriptWorkflowBridge>;
  dynamicWorkflowRunPort: ReturnType<typeof createDynamicWorkflowRunService> | undefined;
  dynamicWorkflowSnippetPort: DynamicWorkflowSnippetPort;
  modelCatalogPort: ModelCatalogPort;
  appVersion: string;
  traceContext: TraceContext;
}) {
  const {
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
  } = input;

  const createdRuntime = new AgentRuntime(sessionId, runtimeConfig, {
    ...(options.readSubagentRuntimeConfig
      ? {
          loadAgentDefinitions: async (input) => {
            const snapshot = await options.readSubagentRuntimeConfig!(input);
            const parsed = subagentProfilesFromSnapshot(snapshot);
            const pluginProfiles =
              snapshot.kind === "built-in-fallback"
                ? []
                : resolvePluginAgentProfiles(
                    {
                      logger,
                      plugins: pluginOutcome.plugins,
                      reservedProfileNames: parsed.profiles.map((profile) => profile.name),
                      modelSelectionOverrides: parsed.pluginAgentModelSelectionOverrides,
                    },
                    pluginTemplates,
                  ).profiles;
            return {
              activeAgents: normalizeAgentProfiles(
                [
                  ...(options.runtimeConfig?.subagents?.profiles ?? []),
                  ...parsed.profiles,
                  ...pluginProfiles,
                ],
                {
                  builtInModelSelectionOverrides: {
                    ...parsed.builtInModelSelectionOverrides,
                    ...options.runtimeConfig?.subagents?.builtInModelSelectionOverrides,
                  },
                },
              ),
            };
          },
        }
      : {}),
    agentTelemetry: modelTelemetry.agentExecution,
    // 主代理的模型请求过治理器的 observer：立即放行，但让治理器看见它的 429 / 成功。
    modelRequestAdmission: workflowConcurrencyGovernor.observer(),
    eventStore: options.eventStore ?? createInMemorySessionEventStore(),
    sessionStore,
    sessionMailboxPort,
    logger,
    executionPort,
    workspaceHookAdmission: workspaceHookRuntimeSecurity?.admission,
    workspaceHookSnapshot: workspaceHookRuntimeSecurity?.snapshot,
    browserControlPort,
    fileSystemPort,
    httpClientPort,
    imageProcessorPort,
    pdfDocumentPort,
    artifactStore,
    contextSourcePort:
      options.contextSourcePort ?? createNodeContextSourceAdapter({ env: options.env }),
    skillPort: createSessionSkillPort(pluginOutcome.skillRoots),
    mcpPort,
    eventSink: options.eventSink,
    modelFactory,
    modelIoDir,
    providerRuntimeHeadersPort: options.providerRuntimeHeadersPort,
    resolveEffectiveModelSelection: options.resolveEffectiveModelSelection,
    isRemoteWorkspace: () =>
      isRemoteWorkspaceIdentity(runtimeConfig.memory?.workspaceIdentity ?? ""),
    permissionBroker: options.permissionBroker,
    permissionService,
    workflowPort: scriptWorkflowFacade.workflowPort,
    dynamicWorkflowRunPort,
    dynamicWorkflowSnippetPort,
    modelCatalogPort,
    automationPort: options.automationPort,
    offPeakPort: options.offPeakPort,
    taskMessagePort: options.taskMessagePort,
    imageGenerationPort: options.imageGenerationPort,
    topicResourcePort: options.topicResourcePort,
    appVersion,
    traceContext,
  });
  return { createdRuntime };
}
