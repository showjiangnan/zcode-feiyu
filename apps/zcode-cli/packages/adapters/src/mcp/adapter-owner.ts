// Modified by ZCode Feiyu.
import type {
  Logger,
  McpElicitationPort,
  McpElicitationTrace,
  McpNotificationPort,
  McpPort,
  McpServerStatus,
} from "@zcode/contracts";
import { type OfficialMcpAuthFailureKind } from "@zcode/shared";
import { randomUUID } from "node:crypto";
import { type SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import * as adapter_authorization from "./adapter-authorization.js";
import * as adapter_connections from "./adapter-connections.js";
import * as adapter_lifecycle from "./adapter-lifecycle.js";
import * as adapter_notifications from "./adapter-notifications.js";
import * as adapter_official_auth from "./adapter-official-auth.js";
import * as adapter_open_connection from "./adapter-open-connection.js";
import * as adapter_resources from "./adapter-resources.js";
import { CreateMcpAdapterOptions, McpServerRecord } from "./adapter-shared.js";
import * as adapter_tool_calls from "./adapter-tool-calls.js";
import * as adapter_transports from "./adapter-transports.js";
import { type NetworkEgressEnvPolicy } from "./network.js";
import { type McpOAuthRuntimeOptions } from "./oauth.js";
import { type McpConnectionContext } from "./pool.js";
import { McpResourceSubscriptionRegistry } from "./resource-subscriptions.js";
import type { McpTelemetryTracker } from "./telemetry.js";
// 所有职责函数绑定同一个 owner；连接、订阅、代际与请求关联仍只有这里的实例状态。
export class NodeMcpAdapter implements McpPort {
  readonly adapterInstanceId = randomUUID();

  readonly clientName: string;

  readonly clientVersion: string;

  readonly connectionContext?: McpConnectionContext;

  readonly env?: NodeJS.ProcessEnv;

  readonly logger?: Logger;

  readonly mcpOAuth?: McpOAuthRuntimeOptions;

  readonly network?: NetworkEgressEnvPolicy;

  readonly officialMcpAuth?: CreateMcpAdapterOptions["officialMcpAuth"];

  readonly telemetry?: McpTelemetryTracker;

  readonly connectionGenerations = new Map<string, number>();

  credentialStore?: SharedZCodeCredentialStore;

  /**
   * 官方鉴权失败分类的暂存槽。不能从 error 对象读——SDK 的 version
   * negotiation 会把 OfficialMcpAuthError 重新包装成普通 Error，instanceof 失效；
   * 也不允许按错误文本反解。因此在抛出点写入，failConnection 取用后立即清除。
   */
  readonly lastOfficialAuthKind = new Map<string, OfficialMcpAuthFailureKind>();

  /**
   * span → 服务端 request id。只有官方 MCP 会写入（唯一能看到响应头的地方是 auth fetch
   * wrapper），供 in-band 失败（HTTP 200 + `isError`）把 id 带回 tool result。
   *
   * 用 span 而不是 traceId 作键：traceId 覆盖整个顶层 session，同一 session 的多次调用
   * 共用它，关联会串号；span 是一次 tool call 的粒度。
   *
   * 有界并即取即删：拿不到匹配的 span（如 initialize / tools/list，它们没有 `_meta`）
   * 就让条目自然被挤出，绝不"取最近一次"兜底——那会把上一次调用的 id 贴到这一次的失败上。
   */
  readonly serverRequestIdBySpan = new Map<string, string>();

  readonly connectionDiagnosticByServer = new Map<
    string,
    Pick<McpServerStatus, "failureKind" | "serverRequestId">
  >();

  readonly records = new Map<string, McpServerRecord>();

  readonly workingDirectory?: string;

  readonly elicitation?: McpElicitationPort;

  readonly notifications?: McpNotificationPort;

  /** 资源订阅登记表 serverName → uri → subscriberKey；唯一 owner，连接层计数。 */
  readonly resourceSubscriptions = new McpResourceSubscriptionRegistry();

  /** tools/list_changed 累计次数，runtime 按此判断是否需要重注册。 */
  toolListRevisionCounter = 0;

  /** 每个 server 当前正在执行的工具调用 trace；elicitation 借此归属到会话 / 工具行。 */
  readonly activeCallTraces = new Map<string, McpElicitationTrace>();

  constructor(options: CreateMcpAdapterOptions) {
    this.clientName = options.clientName ?? "zcode";
    this.clientVersion = options.clientVersion ?? "0.0.0";
    this.connectionContext = options.connectionContext;
    this.env = options.env;
    this.logger = options.logger?.child({
      ...this.connectionContext,
      module: "adapters.mcp",
    });
    this.mcpOAuth = options.mcpOAuth;
    this.network = options.network;
    this.officialMcpAuth = options.officialMcpAuth;
    this.telemetry = options.telemetry;
    this.workingDirectory = options.workingDirectory;
    this.elicitation = options.elicitation;
    this.notifications = options.notifications;
  }

  readonly appConnectionListeners = new Map<string, Set<() => void>>();
  connectConfiguredServers(
    ...args: Parameters<typeof adapter_connections.connectConfiguredServers>
  ): ReturnType<typeof adapter_connections.connectConfiguredServers> {
    return adapter_connections.connectConfiguredServers.call(this, ...args);
  }
  connectServer(
    ...args: Parameters<typeof adapter_connections.connectServer>
  ): ReturnType<typeof adapter_connections.connectServer> {
    return adapter_connections.connectServer.call(this, ...args);
  }
  disconnectServer(
    ...args: Parameters<typeof adapter_connections.disconnectServer>
  ): ReturnType<typeof adapter_connections.disconnectServer> {
    return adapter_connections.disconnectServer.call(this, ...args);
  }
  status(
    ...args: Parameters<typeof adapter_connections.status>
  ): ReturnType<typeof adapter_connections.status> {
    return adapter_connections.status.call(this, ...args);
  }
  pingServer(
    ...args: Parameters<typeof adapter_connections.pingServer>
  ): ReturnType<typeof adapter_connections.pingServer> {
    return adapter_connections.pingServer.call(this, ...args);
  }
  toolListRevision(
    ...args: Parameters<typeof adapter_notifications.toolListRevision>
  ): ReturnType<typeof adapter_notifications.toolListRevision> {
    return adapter_notifications.toolListRevision.call(this, ...args);
  }
  listTools(
    ...args: Parameters<typeof adapter_notifications.listTools>
  ): ReturnType<typeof adapter_notifications.listTools> {
    return adapter_notifications.listTools.call(this, ...args);
  }
  listResources(
    ...args: Parameters<typeof adapter_resources.listResources>
  ): ReturnType<typeof adapter_resources.listResources> {
    return adapter_resources.listResources.call(this, ...args);
  }
  listResourceTemplates(
    ...args: Parameters<typeof adapter_resources.listResourceTemplates>
  ): ReturnType<typeof adapter_resources.listResourceTemplates> {
    return adapter_resources.listResourceTemplates.call(this, ...args);
  }
  subscribeResource(
    ...args: Parameters<typeof adapter_resources.subscribeResource>
  ): ReturnType<typeof adapter_resources.subscribeResource> {
    return adapter_resources.subscribeResource.call(this, ...args);
  }
  unsubscribeResource(
    ...args: Parameters<typeof adapter_resources.unsubscribeResource>
  ): ReturnType<typeof adapter_resources.unsubscribeResource> {
    return adapter_resources.unsubscribeResource.call(this, ...args);
  }
  unsubscribeResourcesBySubscriber(
    ...args: Parameters<typeof adapter_resources.unsubscribeResourcesBySubscriber>
  ): ReturnType<typeof adapter_resources.unsubscribeResourcesBySubscriber> {
    return adapter_resources.unsubscribeResourcesBySubscriber.call(this, ...args);
  }
  resourceSubscriptionCounts(
    ...args: Parameters<typeof adapter_resources.resourceSubscriptionCounts>
  ): ReturnType<typeof adapter_resources.resourceSubscriptionCounts> {
    return adapter_resources.resourceSubscriptionCounts.call(this, ...args);
  }
  unsubscribeOnServer(
    ...args: Parameters<typeof adapter_resources.unsubscribeOnServer>
  ): ReturnType<typeof adapter_resources.unsubscribeOnServer> {
    return adapter_resources.unsubscribeOnServer.call(this, ...args);
  }
  replayResourceSubscriptions(
    ...args: Parameters<typeof adapter_resources.replayResourceSubscriptions>
  ): ReturnType<typeof adapter_resources.replayResourceSubscriptions> {
    return adapter_resources.replayResourceSubscriptions.call(this, ...args);
  }
  resolveForResourceRequest(
    ...args: Parameters<typeof adapter_resources.resolveForResourceRequest>
  ): ReturnType<typeof adapter_resources.resolveForResourceRequest> {
    return adapter_resources.resolveForResourceRequest.call(this, ...args);
  }
  installNotificationHandlers(
    ...args: Parameters<typeof adapter_notifications.installNotificationHandlers>
  ): ReturnType<typeof adapter_notifications.installNotificationHandlers> {
    return adapter_notifications.installNotificationHandlers.call(this, ...args);
  }
  callTool(
    ...args: Parameters<typeof adapter_tool_calls.callTool>
  ): ReturnType<typeof adapter_tool_calls.callTool> {
    return adapter_tool_calls.callTool.call(this, ...args);
  }
  readResource(
    ...args: Parameters<typeof adapter_resources.readResource>
  ): ReturnType<typeof adapter_resources.readResource> {
    return adapter_resources.readResource.call(this, ...args);
  }
  resolveConnectedRecord(
    ...args: Parameters<typeof adapter_notifications.resolveConnectedRecord>
  ): ReturnType<typeof adapter_notifications.resolveConnectedRecord> {
    return adapter_notifications.resolveConnectedRecord.call(this, ...args);
  }
  rememberServerResponse(
    ...args: Parameters<typeof adapter_official_auth.rememberServerResponse>
  ): ReturnType<typeof adapter_official_auth.rememberServerResponse> {
    return adapter_official_auth.rememberServerResponse.call(this, ...args);
  }
  takeServerRequestId(
    ...args: Parameters<typeof adapter_official_auth.takeServerRequestId>
  ): ReturnType<typeof adapter_official_auth.takeServerRequestId> {
    return adapter_official_auth.takeServerRequestId.call(this, ...args);
  }
  resolveOfficialStdioAuthMeta(
    ...args: Parameters<typeof adapter_official_auth.resolveOfficialStdioAuthMeta>
  ): ReturnType<typeof adapter_official_auth.resolveOfficialStdioAuthMeta> {
    return adapter_official_auth.resolveOfficialStdioAuthMeta.call(this, ...args);
  }
  installElicitationHandler(
    ...args: Parameters<typeof adapter_notifications.installElicitationHandler>
  ): ReturnType<typeof adapter_notifications.installElicitationHandler> {
    return adapter_notifications.installElicitationHandler.call(this, ...args);
  }
  callToolOnClient(
    ...args: Parameters<typeof adapter_tool_calls.callToolOnClient>
  ): ReturnType<typeof adapter_tool_calls.callToolOnClient> {
    return adapter_tool_calls.callToolOnClient.call(this, ...args);
  }
  callToolOnClientInner(
    ...args: Parameters<typeof adapter_tool_calls.callToolOnClientInner>
  ): ReturnType<typeof adapter_tool_calls.callToolOnClientInner> {
    return adapter_tool_calls.callToolOnClientInner.call(this, ...args);
  }
  reconnectForCall(
    ...args: Parameters<typeof adapter_tool_calls.reconnectForCall>
  ): ReturnType<typeof adapter_tool_calls.reconnectForCall> {
    return adapter_tool_calls.reconnectForCall.call(this, ...args);
  }
  recoverToolCallAuthorization(
    ...args: Parameters<typeof adapter_authorization.recoverToolCallAuthorization>
  ): ReturnType<typeof adapter_authorization.recoverToolCallAuthorization> {
    return adapter_authorization.recoverToolCallAuthorization.call(this, ...args);
  }
  ensureToolCallAuthorizationRecovery(
    ...args: Parameters<typeof adapter_authorization.ensureToolCallAuthorizationRecovery>
  ): ReturnType<typeof adapter_authorization.ensureToolCallAuthorizationRecovery> {
    return adapter_authorization.ensureToolCallAuthorizationRecovery.call(this, ...args);
  }
  runToolCallAuthorizationRecovery(
    ...args: Parameters<typeof adapter_authorization.runToolCallAuthorizationRecovery>
  ): ReturnType<typeof adapter_authorization.runToolCallAuthorizationRecovery> {
    return adapter_authorization.runToolCallAuthorizationRecovery.call(this, ...args);
  }
  close(
    ...args: Parameters<typeof adapter_lifecycle.close>
  ): ReturnType<typeof adapter_lifecycle.close> {
    return adapter_lifecycle.close.call(this, ...args);
  }
  waitForSharedConnection(
    ...args: Parameters<typeof adapter_connections.waitForSharedConnection>
  ): ReturnType<typeof adapter_connections.waitForSharedConnection> {
    return adapter_connections.waitForSharedConnection.call(this, ...args);
  }
  openServerConnection(
    ...args: Parameters<typeof adapter_open_connection.openServerConnection>
  ): ReturnType<typeof adapter_open_connection.openServerConnection> {
    return adapter_open_connection.openServerConnection.call(this, ...args);
  }
  runInteractiveOAuthAuthorization(
    ...args: Parameters<typeof adapter_authorization.runInteractiveOAuthAuthorization>
  ): ReturnType<typeof adapter_authorization.runInteractiveOAuthAuthorization> {
    return adapter_authorization.runInteractiveOAuthAuthorization.call(this, ...args);
  }
  failConnection(
    ...args: Parameters<typeof adapter_lifecycle.failConnection>
  ): ReturnType<typeof adapter_lifecycle.failConnection> {
    return adapter_lifecycle.failConnection.call(this, ...args);
  }
  createTransport(
    ...args: Parameters<typeof adapter_transports.createTransport>
  ): ReturnType<typeof adapter_transports.createTransport> {
    return adapter_transports.createTransport.call(this, ...args);
  }
  createOfficialAuthFetch(
    ...args: Parameters<typeof adapter_official_auth.createOfficialAuthFetch>
  ): ReturnType<typeof adapter_official_auth.createOfficialAuthFetch> {
    return adapter_official_auth.createOfficialAuthFetch.call(this, ...args);
  }
  createOAuthClientProvider(
    ...args: Parameters<typeof adapter_transports.createOAuthClientProvider>
  ): ReturnType<typeof adapter_transports.createOAuthClientProvider> {
    return adapter_transports.createOAuthClientProvider.call(this, ...args);
  }
  resolveCredentialStore(
    ...args: Parameters<typeof adapter_transports.resolveCredentialStore>
  ): ReturnType<typeof adapter_transports.resolveCredentialStore> {
    return adapter_transports.resolveCredentialStore.call(this, ...args);
  }
  createAuthorizationCodeOAuthOptions(
    ...args: Parameters<typeof adapter_transports.createAuthorizationCodeOAuthOptions>
  ): ReturnType<typeof adapter_transports.createAuthorizationCodeOAuthOptions> {
    return adapter_transports.createAuthorizationCodeOAuthOptions.call(this, ...args);
  }
  attachStdioLogging(
    ...args: Parameters<typeof adapter_transports.attachStdioLogging>
  ): ReturnType<typeof adapter_transports.attachStdioLogging> {
    return adapter_transports.attachStdioLogging.call(this, ...args);
  }
  closeRecord(
    ...args: Parameters<typeof adapter_lifecycle.closeRecord>
  ): ReturnType<typeof adapter_lifecycle.closeRecord> {
    return adapter_lifecycle.closeRecord.call(this, ...args);
  }
  closeClientAndTransport(
    ...args: Parameters<typeof adapter_lifecycle.closeClientAndTransport>
  ): ReturnType<typeof adapter_lifecycle.closeClientAndTransport> {
    return adapter_lifecycle.closeClientAndTransport.call(this, ...args);
  }
  terminateStdioProcessTree(
    ...args: Parameters<typeof adapter_lifecycle.terminateStdioProcessTree>
  ): ReturnType<typeof adapter_lifecycle.terminateStdioProcessTree> {
    return adapter_lifecycle.terminateStdioProcessTree.call(this, ...args);
  }
  onAppConnectionInvalidated(
    ...args: Parameters<typeof adapter_lifecycle.onAppConnectionInvalidated>
  ): ReturnType<typeof adapter_lifecycle.onAppConnectionInvalidated> {
    return adapter_lifecycle.onAppConnectionInvalidated.call(this, ...args);
  }
  appConnectionSnapshot(
    ...args: Parameters<typeof adapter_lifecycle.appConnectionSnapshot>
  ): ReturnType<typeof adapter_lifecycle.appConnectionSnapshot> {
    return adapter_lifecycle.appConnectionSnapshot.call(this, ...args);
  }
  nextConnectionGeneration(
    ...args: Parameters<typeof adapter_lifecycle.nextConnectionGeneration>
  ): ReturnType<typeof adapter_lifecycle.nextConnectionGeneration> {
    return adapter_lifecycle.nextConnectionGeneration.call(this, ...args);
  }
  isCurrentConnection(
    ...args: Parameters<typeof adapter_lifecycle.isCurrentConnection>
  ): ReturnType<typeof adapter_lifecycle.isCurrentConnection> {
    return adapter_lifecycle.isCurrentConnection.call(this, ...args);
  }
  updateCurrentRecord(
    ...args: Parameters<typeof adapter_lifecycle.updateCurrentRecord>
  ): ReturnType<typeof adapter_lifecycle.updateCurrentRecord> {
    return adapter_lifecycle.updateCurrentRecord.call(this, ...args);
  }
  updateCurrentRecordStatus(
    ...args: Parameters<typeof adapter_lifecycle.updateCurrentRecordStatus>
  ): ReturnType<typeof adapter_lifecycle.updateCurrentRecordStatus> {
    return adapter_lifecycle.updateCurrentRecordStatus.call(this, ...args);
  }
  createStatus(
    ...args: Parameters<typeof adapter_lifecycle.createStatus>
  ): ReturnType<typeof adapter_lifecycle.createStatus> {
    return adapter_lifecycle.createStatus.call(this, ...args);
  }
}
