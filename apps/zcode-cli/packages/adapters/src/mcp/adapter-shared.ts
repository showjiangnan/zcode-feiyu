// Modified by ZCode Feiyu.
import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnsupportedProtocolVersionError,
  type VersionNegotiationMode,
  type VersionNegotiationOptions,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type {
  Logger,
  McpCallToolRequest,
  McpElicitationPort,
  McpNotificationPort,
  McpOAuthConfig,
  McpServerConfig,
  McpServerStatus,
  McpToolDescriptor,
  OfficialMcpAuthFailureReason,
  OfficialMcpAuthHeadersPort,
  OfficialMcpTrustedOriginRegistry,
} from "@zcode/contracts";
import { type NetworkEgressEnvPolicy } from "./network.js";
import { type McpOAuthAuthorizationContext, type McpOAuthRuntimeOptions } from "./oauth.js";
import { type McpConnectionContext } from "./pool.js";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";
import type { McpTelemetryTracker } from "./telemetry.js";

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

export // 存活探测只允许占用很短的时间：它挂在设置页刷新的同步路径上，超时即判死并触发重连。
const MCP_PING_TIMEOUT_MS = 5_000;

export const MAX_MCP_VERSION_PROBE_TIMEOUT_MS = 5_000;

export const MCP_STDIO_STDERR_LOG_MAX_CHARS = 4_000;

export /**
 * span → request id 的暂存条数上限。正常情况下每条都会在同一次 tool call 结束时被取走，
 * 留下的只有无人认领的（如连接期请求），几十条足够，纯为防止长会话下无界增长。
 */
const MAX_TRACKED_SERVER_REQUEST_IDS = 64;

export interface CreateMcpAdapterOptions {
  clientName?: string;
  clientVersion?: string;
  connectionContext?: McpConnectionContext;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  telemetry?: McpTelemetryTracker;
  mcpOAuth?: McpOAuthRuntimeOptions;
  network?: NetworkEgressEnvPolicy;
  /**
   * 官方 Server MCP 鉴权依赖。trustedOrigins 缺失时仍 fail closed；authHeadersPort
   * 可缺省，此时各请求匿名降级并交给服务端做权威判定。
   */
  officialMcpAuth?: {
    authHeadersPort?: OfficialMcpAuthHeadersPort;
    trustedOrigins: OfficialMcpTrustedOriginRegistry;
    /**
     * 当前 ZCode API origin。stdio 形态没有 `url` 可供校验，targetOrigin 只能由宿主给出
     * ——插件因此无法把身份头导向别的 origin。
     * 与 trustedOrigins 的 `resolveZCodeApiOrigin` 必须同源，否则两侧判定会分叉。
     */
    resolveZCodeApiOrigin?: () => string;
    workspaceIdentity?: string;
  };
  workingDirectory?: string;
  /** 有此端口才向 server 宣告 elicitation 能力；缺省时 server 的 elicitation/create 收到 method not found。 */
  elicitation?: McpElicitationPort;
  /** server → client 通知（资源更新 / 列表变化 / 工具列表变化 / 日志）的出口；缺省只记 debug。 */
  notifications?: McpNotificationPort;
}

export type McpClient = Client;

export type McpTransport =
  | StdioClientTransport
  | StreamableHTTPClientTransport
  | SSEClientTransport;

export type AuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

export /**
 * stdio 官方 MCP 的身份头载荷，随每条出站协议消息的 `_meta` 下发。
 *
 * 失败也下发（`ok: false` + 枚举 reason）；stdio 插件拿不到头时不会去打官方端点。HTTP 路径则
 * 由 adapter 发起无身份的 tools/call，让 ZCode server 返回权威结构化错误。把 reason 交给 stdio
 * 插件才能让它把"未登录"与"无 Coding Plan
 * 套餐"如实呈现给用户，而不是静默降级成一句莫名其妙的失败。
 */
type OfficialMcpAuthMetaPayload =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

/** 订阅的 server → client 通知方法名（MCP 规范）。 */
export const MCP_NOTIFICATION_TOOLS_LIST_CHANGED = "notifications/tools/list_changed";

export const MCP_NOTIFICATION_RESOURCES_UPDATED = "notifications/resources/updated";

export const MCP_NOTIFICATION_RESOURCES_LIST_CHANGED = "notifications/resources/list_changed";

export const MCP_NOTIFICATION_MESSAGE = "notifications/message";

export interface McpServerRecord {
  client?: McpClient;
  abortController?: AbortController;
  connecting?: Promise<McpServerStatus>;
  config: McpServerConfig;
  status: McpServerStatus;
  tools: McpToolDescriptor[];
  /** 收到 tools/list_changed 后置位，下一次 listTools 重拉。 */
  toolsStale?: boolean;
  transport?: McpTransport;
}

export /** resources/list 项：只透传标准字段（含 _meta），丢掉 SDK 附加的运行时字段。 */
function pickResourceDescriptor(
  resource: unknown,
  includeUri = true,
): {
  uri?: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
} {
  const item = isRecord(resource) ? resource : {};
  return {
    ...(includeUri ? { uri: typeof item.uri === "string" ? item.uri : "" } : {}),
    ...(typeof item.name === "string" ? { name: item.name } : {}),
    ...(typeof item.title === "string" ? { title: item.title } : {}),
    ...(typeof item.description === "string" ? { description: item.description } : {}),
    ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
    ...(isRecord(item._meta) ? { _meta: item._meta } : {}),
  };
}

export /** elicitation 模式白名单（MCP form 与 兼容别名）。 */
const SUPPORTED_ELICITATION_MODES = new Set(["form", "openai/form", "openaiForm"]);

export function isSupportedElicitationMode(mode: unknown): boolean {
  return mode === undefined || (typeof mode === "string" && SUPPORTED_ELICITATION_MODES.has(mode));
}

export function mcpRequestMeta(request: McpCallToolRequest): Record<string, unknown> {
  // nodeRepl.requestMeta 暴露。ZCode 所有 MCP server 都可忽略这些扩展键；node_repl browser
  // bridge 则以它们作为回到当前 BrowserControlPort session 的唯一关联依据。runtime_scope
  // 不能从 child session id 猜测，必须由实际执行工具的 runtime 显式透传。
  const requestContext = {
    ...(request.trace ? { trace_id: request.trace.traceId } : {}),
    ...(request.trace?.spanId ? { span_id: request.trace.spanId } : {}),
    ...(request.trace?.parentSpanId ? { parent_span_id: request.trace.parentSpanId } : {}),
    ...(request.trace?.sessionId ? { session_id: request.trace.sessionId } : {}),
    ...(request.trace?.turnId ? { turn_id: request.trace.turnId } : {}),
    ...(request.runtimeScope ? { runtime_scope: request.runtimeScope } : {}),
    ...(request.taskType ? { task_type: request.taskType } : {}),
    ...(request.workspacePath ? { workspace_path: request.workspacePath } : {}),
    ...(request.workspaceIdentity ? { workspace_identity: request.workspaceIdentity } : {}),
    ...(request.workspaceKey ? { workspace_key: request.workspaceKey } : {}),
    ...(request.remoteSessionId ? { remote_session_id: request.remoteSessionId } : {}),
    ...(request.clientMode ? { client_mode: request.clientMode } : {}),
    ...(request.deliveryKind ? { delivery_kind: request.deliveryKind } : {}),
    ...(request.turnId && !request.trace?.turnId ? { turn_id: request.turnId } : {}),
  };
  return {
    ...requestContext,
    "com.zcode/request-context": requestContext,
  };
}

export function resolveVersionNegotiationMode(config: McpServerConfig): VersionNegotiationMode {
  if (config.protocolVersion === "2026-07-28") return { pin: "2026-07-28" };
  // deprecated SSE transport 本身只承载 legacy era；显式 modern pin 仍应失败而不能静默降级。
  if (config.type === "sse") return "legacy";
  if (config.protocolVersion === "legacy") return "legacy";
  return "auto";
}

export /**
 * SDK 版本协商（auto/pin 的 server/discover probe）失败的稳定识别。
 *
 * 结构化判定，禁止匹配错误文本：
 * - `SdkError(SdkErrorCode.EraNegotiationFailed)`：probe 硬失败（含非标 legacy server 的
 *   malformed 200 响应，经 transport 层 Zod 校验失败 + normalizeReply 落入 network-error 分支）；
 * - `UnsupportedProtocolVersionError`：recognized modern error，pin 版本不被 server 接受。
 */
function isProtocolNegotiationFailure(error: unknown): boolean {
  if (SdkError.isInstance(error) && error.code === SdkErrorCode.EraNegotiationFailed) {
    return true;
  }
  if (UnsupportedProtocolVersionError.isInstance(error)) return true;
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (cause !== undefined && cause !== error) {
    return isProtocolNegotiationFailure(cause);
  }
  return false;
}

export function formatVersionNegotiationMode(config: McpServerConfig): string {
  const mode = resolveVersionNegotiationMode(config);
  return typeof mode === "object" ? mode.pin : mode;
}

export function resolveVersionNegotiation(
  config: McpServerConfig,
  timeoutMs: number,
): VersionNegotiationOptions {
  const mode = resolveVersionNegotiationMode(config);
  if (mode === "legacy") return { mode };

  // pin 没有 legacy fallback，probe 就是唯一 initialize 路径；沿用 auto 的 5 秒
  // 保护上限会无视 server 的长连接预算，把冷启动正常但超过 5 秒的 node_repl 静默移出工具池。
  const probeTimeoutMs =
    typeof mode === "object"
      ? Math.max(1, Math.floor(timeoutMs))
      : Math.min(MAX_MCP_VERSION_PROBE_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs / 2)));

  return {
    mode,
    probe: {
      // 原因：SDK 的 stdio auto/pin 会先启动 disposable sibling；若沿用 SDK 60s 默认值，
      // ZCode 的总连接超时可能先结束并让 probe 残留，也不给 legacy initialize 留预算。
      timeoutMs: probeTimeoutMs,
    },
  };
}

export function createOAuthAuthorizationStatus(
  context: McpOAuthAuthorizationContext,
): NonNullable<McpServerStatus["authorization"]> {
  return {
    type: "oauth_authorization_code",
    authorizationUrl: context.authorizationUrl,
    startedAt: new Date().toISOString(),
  };
}

export function resolveAuthorizationCodeOAuthConfig(
  config: McpServerConfig,
): AuthorizationCodeOAuthConfig | undefined {
  if (config.type === "stdio") return undefined;
  // 官方鉴权与 MCP OAuth 互斥。必须位于所有既有分支之前：
  // 官方 MCP 既不写 oauth 字段、又禁止静态 authorization 头，若不在此短路就会落进
  // 下面的 authorization_code 兜底，导致 401 时弹出 MCP 授权 UI —— 而官方鉴权失败
  // 只能由 ZCode 自身的登录/套餐解决，不可能由目标 MCP 的 OAuth 授权解决。
  if (isOfficialAuthConfig(config)) return undefined;
  if (config.oauth?.type === "authorization_code") return config.oauth;
  if (config.oauth?.type === "client_credentials") return undefined;
  if (hasAuthorizationHeader(config.headers)) return undefined;

  // 新建 HTTP/SSE MCP 常只保存 URL；OAuth 支持应由服务端
  // WWW-Authenticate / discovery 触发，不能要求配置里预先写 oauth 字段。
  return {
    type: "authorization_code",
  };
}

export /**
 * auth.type/provider 精确命中且 provenance 存在时为真；provenance 缺失说明不是 Plugin loader
 * 产出的配置。
 *
 * 覆盖 http 与 stdio 两种形态——两者的凭证投递通道不同，但"是否官方鉴权"
 * 的判定同源。调用方若只关心某一形态，需自行再判 `config.type`（如 createOfficialAuthFetch
 * 只处理 http、_meta 注入只处理 stdio）。
 */
function isOfficialAuthConfig(config: McpServerConfig): boolean {
  return (
    (config.type === "http" || config.type === "stdio") &&
    config.auth?.type === "zcode_official" &&
    config.auth.provider === "jwt_token" &&
    config.official !== undefined
  );
}

export function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

export function createBoundedTextBuffer(maxChars: number): {
  append(text: string): void;
  read(): string;
} {
  let value = "";
  return {
    append(text: string) {
      if (!text) return;
      value = `${value}${text}`;
      if (value.length > maxChars) {
        value = value.slice(-maxChars);
      }
    },
    read() {
      return value;
    },
  };
}

export function sanitizeMcpStdioStderr(text: string): string {
  const sensitiveKey = String.raw`(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|private[_-]?key|token|password|passwd|pass|mysql_pass|mysql_password)`;
  let result = text.replace(/(bearer\s+)[^\s"']+/gi, "$1[Redacted]");
  result = result.replace(
    /(\bauthorization\b\s*[:=]\s*)(bearer\s+)?[^\r\n]+/gi,
    (_match, prefix: string, bearer: string | undefined) =>
      `${prefix}${bearer ? "Bearer " : ""}[Redacted]`,
  );
  result = result.replace(new RegExp(`([?&]${sensitiveKey}=)[^&\\s]+`, "gi"), "$1[Redacted]");
  result = result.replace(
    new RegExp(`(["']${sensitiveKey}["']\\s*:\\s*)(["'])(?:(?!\\2).)*\\2`, "gi"),
    "$1$2[Redacted]$2",
  );
  result = result.replace(
    new RegExp(`(\\b${sensitiveKey}\\b\\s*[:=]\\s*)(["']?)[^\\s"',;)}]+`, "gi"),
    "$1$2[Redacted]",
  );
  return result.replace(/([a-z][a-z0-9+.-]*:\/\/)[^:\s/@]+:[^@\s/]+@/gi, "$1[Redacted]@");
}

export function getStdioTransportPid(transport?: McpTransport): number | undefined {
  if (!(transport instanceof StdioClientTransport)) return undefined;
  const pid = transport.pid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function getStdioTransportExitInfo(transport?: McpTransport):
  | {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }
  | undefined {
  return transport instanceof ProcessTreeStdioClientTransport ? transport.processExit : undefined;
}

export function isStdioTransportProcessAlive(transport?: McpTransport): boolean {
  return transport instanceof ProcessTreeStdioClientTransport && transport.processAlive;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export // server 回了 JSON-RPC 错误响应（数字 code）说明请求走通了、连接是活的；
// SDK 本地错误（SdkError，字符串 code：REQUEST_TIMEOUT / CONNECTION_CLOSED / NOT_CONNECTED
// / SEND_FAILED）才代表 transport 已断。code 类型判断兜底 instanceof 在多份 SDK 实例下失效的情况。
function isPeerAnsweredError(error: unknown): boolean {
  if (error instanceof ProtocolError) return true;
  return isRecord(error) && typeof error.code === "number";
}
