// Modified by ZCode Feiyu.
import { type ToolExecutionSpanWriter } from "@zcode/contracts";

import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";

import type { ExecutableToolCall, ToolExecutionContext } from "../types.js";

import { createToolModelStatusSink, withDefaultToolModelStatusSink } from "./model-status-sink.js";

import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";

import type { TraceContext } from "@zcode/contracts";

// 执行上下文沿用准入后的事实和回调；文件/技能元数据仍由执行收口闭包持有。
export function createToolExecutionContext(input: {
  deps: ToolExecutorDeps;
  canonicalToolCall: ExecutableToolCall;
  options?: ToolExecuteOptions;
  telemetry?: ToolExecutionSpanWriter;
  traceContext: TraceContext;
  traceId: TraceContext["traceId"];
  turnId: TraceContext["turnId"];
  abortSignal: AbortSignal;
  emitEvent: ToolExecutionContext["emitEvent"];
  recordReadFileStateMetadata: ToolExecutionContext["recordReadFileStateMetadata"];
  recordSkillTelemetryMetadata: ToolExecutionContext["recordSkillTelemetryMetadata"];
}): ToolExecutionContext {
  const {
    deps,
    canonicalToolCall,
    options,
    telemetry,
    traceContext,
    traceId,
    turnId,
    abortSignal,
    emitEvent,
    recordReadFileStateMetadata,
    recordSkillTelemetryMetadata,
  } = input;
  const model = options?.model ?? deps.model;
  const bashShellSelection = deps.getBashShellSelection?.() ?? deps.bashShellSelection;
  const embeddedSearchDecision = resolveEmbeddedSearchBranchCapability({
    bashAvailable: deps.registry.has("Bash"),
  });
  return {
    toolCallId: canonicalToolCall.id,
    telemetry,
    automationTurn: options?.automationTurn,
    offPeakTurn: options?.offPeakTurn,
    traceContext,
    traceId,
    spanId: traceContext.spanId,
    parentSpanId: traceContext.parentSpanId,
    abortSignal,
    backgroundTaskControlPort: deps.backgroundTaskControlPort,
    emitEvent,
    executionPort: deps.executionPort,
    browserControlPort: deps.browserControlPort,
    browserDocumentationRoot: deps.browserDocumentationRoot,
    fileSystemPort: deps.fileSystemPort,
    httpClientPort: deps.httpClientPort,
    imageProcessorPort: deps.imageProcessorPort,
    pdfDocumentPort: deps.pdfDocumentPort,
    // 工具内部的模型请求默认把状态事件发进会话：deadline 暂停与 driver 相位都靠这条流。
    model: withDefaultToolModelStatusSink(
      model,
      createToolModelStatusSink({ emitEvent, sessionId: deps.sessionId, turnId, traceId }),
    ),
    subagentModelOverride: options?.subagentModelOverride,
    embeddedSearch: {
      ...(deps.embeddedSearchBackend ? { backend: deps.embeddedSearchBackend } : {}),
      enabled: embeddedSearchDecision?.useEmbeddedSearchBranch ?? false,
      ...(deps.nativeSearchEnhancementsEnabled === false ? { findAndGrepEnabled: false } : {}),
    },
    // getter 存在但返回空意味着已关闭；不能回退到启动时的旧技能端口。
    skillPort: deps.getSkillPort ? deps.getSkillPort() : deps.skillPort,
    subagentPort: deps.subagentPort,
    teamBoardPort: deps.teamBoardPort,
    teamActorId: deps.teamActorId,
    coordinatorResponsePort: deps.coordinatorResponsePort,
    workflowSubmitPort: deps.workflowSubmitPort,
    workflowEscalatePort: deps.workflowEscalatePort,
    artifactStore: deps.artifactStore,
    automationPort: deps.automationPort,
    offPeakPort: deps.offPeakPort,
    taskMessagePort: deps.taskMessagePort,
    imageGenerationPort: deps.imageGenerationPort,
    topicResourcePort: deps.topicResourcePort,
    paidImageInputId: deps.getPaidImageInputId?.(),
    sessionStore: deps.sessionStore,
    sessionModePort: deps.sessionModePort,
    workflowPort: deps.workflowPort,
    dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort,
    dynamicWorkflowSnippetPort: deps.dynamicWorkflowSnippetPort,
    modelCatalogPort: deps.modelCatalogPort,
    runtimeTaskRegistry: deps.runtimeTaskRegistry,
    readFileState: deps.readFileState,
    recordReadFileStateMetadata,
    recordSkillTelemetryMetadata,
    bashShellSelection,
    setWorkingDirectory: deps.setWorkingDirectory,
    workingDirectory: deps.getWorkingDirectory(),
    workspaceRoot: deps.getWorkspaceRoot(),
    workspaceIdentity: deps.workspaceIdentity,
    remoteSessionId: deps.remoteSessionId,
    clientMode: deps.clientMode,
    deliveryKind: deps.deliveryKind,
    memoryRoot: deps.getMemoryRoot?.(),
    memoryOwnershipFence: deps.getMemoryOwnershipFence?.(),
    runtimeScope: deps.runtimeScope,
    taskType: deps.taskType,
    providerVisibleToolNames: deps.registry
      .list()
      .filter((name) => deps.registry.getMetadata(name)?.providerVisible !== false),
    sessionId: deps.sessionId,
    turnId,
  };
}
