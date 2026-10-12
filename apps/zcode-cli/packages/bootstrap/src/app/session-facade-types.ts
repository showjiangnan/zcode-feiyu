// Modified by ZCode Feiyu.
import { type ConfigResult } from "@zcode/adapters/config";
import {
  type ExecutionPort,
  type LocalSettingStorePort,
  type Logger,
  type LoggerFactory,
  type McpPort,
  type McpServerConfig,
  type ProjectId,
  type SessionId,
  type SessionStorePort,
  type SupportedLocale,
  type TraceContext,
  type UiLocale,
} from "@zcode/contracts";
import { type AgentRuntime } from "@zcode/core";

import { type ModelSelection } from "@zcode/provider";

import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";

import type { PrepareUserExecutionBoundary, ZCodeApp } from "./types.js";
export type SessionFacade = Pick<
  ZCodeApp,
  | "readBackgroundBashOutput"
  | "cancelBackgroundTask"
  | "clearTarget"
  | "close"
  | "callMcpToolForUi"
  | "getMcpAppConnectionSnapshot"
  | "onMcpAppConnectionInvalidated"
  | "replaceMcpAppProvidedTools"
  | "connectMcpServer"
  | "disconnectMcpServer"
  | "generateWorkspaceText"
  | "sampleModel"
  | "testModelConnectivity"
  | "forkFromCheckpoint"
  | "getMode"
  | "getModel"
  | "getCurrentModelOption"
  | "getModelOption"
  | "getLocale"
  | "getDefaultThoughtLevel"
  | "getThoughtLevel"
  | "getTheme"
  | "listCheckpoints"
  | "listMcpServers"
  | "getMcpToolVisibility"
  | "listModels"
  | "listThoughtLevels"
  | "loadSessionTranscript"
  | "readMcpResource"
  | "readMcpResourceForUi"
  | "listMcpResourcesForUi"
  | "listMcpResourceTemplatesForUi"
  | "subscribeMcpResourceForUi"
  | "unsubscribeMcpResourceForUi"
  | "unsubscribeMcpResourcesForUi"
  | "readSubagents"
  | "readSubagentTranscript"
  | "readTodos"
  | "readTarget"
  | "setCustomSessionTitle"
  | "setMode"
  | "setModel"
  | "setThoughtLevel"
  | "setLocale"
  | "setTarget"
  | "updateTargetStatus"
>;
export interface CreateSessionFacadeDeps {
  /**
   * 停下本会话拥有的 dwf run：
   * run service 的 `close()`。缺席即本装配没有 dwf 端口（journal 窄化失败、测试装配）。
   */
  closeDynamicWorkflowRuns?: () => Promise<void>;
  closeNodeReplBrowserBroker?: () => Promise<void> | undefined;
  configResult: ConfigResult;
  configuredMcpServers: Record<string, McpServerConfig>;
  configuredDefaultModelSelection?: ModelSelection;
  executionPort: ExecutionPort;
  localSettingStore?: LocalSettingStorePort;
  logger: Logger;
  loggerFactory: LoggerFactory;
  mcpPort?: McpPort;
  ownsExecutionPort: boolean;
  ownsMcpPort: boolean;
  ownsSessionStore: boolean;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  prepareResume(traceContext?: TraceContext): Promise<void>;
  projectID: ProjectId;
  providerRegistry: ProviderRegistryModelSource;
  resolveUiLocale(locale: UiLocale): SupportedLocale;
  runtime: AgentRuntime;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  traceContext: TraceContext;
  untrustedProjectMcpServers: Set<string>;
  workingDirectory: string;
}
