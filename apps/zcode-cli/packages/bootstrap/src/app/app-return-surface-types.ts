// Modified by ZCode Feiyu.
import type { SessionStorePort } from "@zcode/contracts";
import type { ConfigResult } from "@zcode/adapters/config";
import type {
  ToolArtifactStorePort,
  SessionId,
  FileSystemPort,
  PluginReferenceCatalog,
} from "@zcode/contracts";
import type { WorkspaceHookRuntimeSecurity } from "./workspace-hook-trust.js";
import { createScriptWorkflowBridge } from "./script-workflow-methods.js";
import { createDynamicWorkflowRunService } from "./dynamic-workflow-run-service.js";
import { createInputFacade } from "./input-facade.js";
import { createSessionFacade } from "./session-facade.js";
import { createWorkflowFacade } from "./workflow-facade.js";
import { createModelTelemetry } from "@zcode/telemetry";
import { createModelAdapter } from "../model-factory.js";
import { type TraceContext } from "@zcode/contracts";
import { AgentRuntime, type ResumeSessionResult } from "@zcode/core";

import { ApiProviderModelRuntime } from "./provider-registry-model-runtime.js";
import type { PrepareUserExecutionBoundary, ResumeOptions, ZCodeAppOptions } from "./types.js";
// 唯一装配上下文传递原实例；不持有新的会话或队列。
export interface AppReturnSurfaceInput {
  sessionStore: SessionStorePort;
  sessionId: SessionId;
  traceContext: TraceContext;
  runtime: AgentRuntime;
  workspaceHookRuntimeSecurity: WorkspaceHookRuntimeSecurity | undefined;
  modelAdapter: ReturnType<typeof createModelAdapter>;
  artifactStore: ToolArtifactStorePort;
  fileSystemPort: FileSystemPort;
  sessionFacade: ReturnType<typeof createSessionFacade>;
  closeSession: (() => Promise<void>) | undefined;
  providerModelRuntime: ApiProviderModelRuntime | undefined;
  modelTelemetry: ReturnType<typeof createModelTelemetry>;
  workflowFacade: ReturnType<typeof createWorkflowFacade>;
  scriptWorkflowFacade: ReturnType<typeof createScriptWorkflowBridge>;
  dynamicWorkflowRunPort: ReturnType<typeof createDynamicWorkflowRunService> | undefined;
  getRuntime: () => AgentRuntime;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  configResult: ConfigResult;
  options: ZCodeAppOptions;
  workingDirectory: string;
  readPluginReferenceCatalog: () => PluginReferenceCatalog;
  resumeFromStore: (resumeOptions?: ResumeOptions) => Promise<ResumeSessionResult>;
  inputFacade: ReturnType<typeof createInputFacade>;
}
