// Modified by ZCode Feiyu.
import type {
  McpCallToolOptions,
  McpCallToolRequest,
  McpContentBlock,
  McpServerConfig,
  McpToolCallResult,
} from "@zcode/contracts";
import { ZCODE_MCP_SERVER_REQUEST_ID_META_KEY } from "@zcode/contracts";
import type { NodeMcpAdapter } from "./adapter-owner.js";
import {
  DEFAULT_MCP_TIMEOUT_MS,
  McpClient,
  McpServerRecord,
  isRecord,
  mcpRequestMeta,
} from "./adapter-shared.js";
import { classifyInteractiveAuthorizationTrigger } from "./oauth-errors.js";
import { createMcpDeadline, remainingMcpDeadlineMs, waitWithinMcpDeadline } from "./timeout.js";

export async function callTool(
  this: NodeMcpAdapter,
  request: McpCallToolRequest,
  options: McpCallToolOptions = {},
): Promise<McpToolCallResult> {
  const timeoutMs =
    options.timeoutMs ??
    this.records.get(request.serverName)?.config.timeoutMs ??
    DEFAULT_MCP_TIMEOUT_MS;
  const deadline = createMcpDeadline(timeoutMs);
  const timeoutMessage = `MCP tool ${request.serverName}/${request.toolName} timed out after ${timeoutMs}ms`;
  let record: McpServerRecord & { client: McpClient };
  if (options.appConnection) {
    const snapshot = this.appConnectionSnapshot(request.serverName);
    const current = this.records.get(request.serverName);
    if (
      !snapshot ||
      snapshot.identity !== options.appConnection.identity ||
      snapshot.generation !== options.appConnection.generation ||
      !current?.client
    )
      throw new Error("MCP App connection changed");
    options.signal?.throwIfAborted();
    record = current as McpServerRecord & { client: McpClient };
  } else {
    record = await this.resolveConnectedRecord(
      request.serverName,
      deadline,
      timeoutMessage,
      options.signal,
    );
  }

  try {
    return await this.callToolOnClient(
      record.client,
      request,
      remainingMcpDeadlineMs(deadline, timeoutMessage),
      options.signal,
      options.onProgress,
    );
  } catch (error) {
    if (options.appConnection) throw error;
    // 连接建立后 token 过期、被撤销或 scope 不足时，
    // 过去这些认证错误原样冒泡，用户看到裸错误且永远不会自愈——OAuth 自愈只存在于
    // startup connect 路径。现在运行期与建连期共用同一套 Phase 2 → Phase 1 编排。
    const trigger = classifyInteractiveAuthorizationTrigger(error);
    if (trigger && record.config.type !== "stdio") {
      return await this.recoverToolCallAuthorization({
        error,
        record,
        request,
        deadline,
        timeoutMessage,
        trigger,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      });
    }
    // 防 onclose 尚未派发的竞态：SDK 在 transport 已断时抛裸 "Not connected"。
    // 只对这一种确定的断连错误重连重试一次，其余错误原样冒泡。
    if (!(error instanceof Error) || error.message !== "Not connected") throw error;
    try {
      await waitWithinMcpDeadline(
        this.reconnectForCall(request.serverName, record.config),
        deadline,
        timeoutMessage,
        options.signal,
      );
    } catch (reconnectError) {
      this.logger?.warn("MCP server reconnect failed", {
        error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
        event: "mcp.server.reconnect.failed",
        mcpServerName: request.serverName,
        status: "failed",
      });
      throw error;
    }
    const revived = this.records.get(request.serverName);
    if (!revived?.client || revived.status.status !== "connected") throw error;
    return await this.callToolOnClient(
      revived.client,
      request,
      remainingMcpDeadlineMs(deadline, timeoutMessage),
      options.signal,
      options.onProgress,
    );
  }
}

export async function callToolOnClient(
  this: NodeMcpAdapter,
  client: McpClient,
  request: McpCallToolRequest,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onProgress?: McpCallToolOptions["onProgress"],
): Promise<McpToolCallResult> {
  this.activeCallTraces.set(request.serverName, {
    ...(request.trace?.sessionId ? { sessionId: String(request.trace.sessionId) } : {}),
    ...(request.trace?.turnId ? { turnId: String(request.trace.turnId) } : {}),
    ...(request.trace?.traceId ? { traceId: String(request.trace.traceId) } : {}),
  });
  try {
    return await this.callToolOnClientInner(client, request, timeoutMs, signal, onProgress);
  } finally {
    this.activeCallTraces.delete(request.serverName);
  }
}

export async function callToolOnClientInner(
  this: NodeMcpAdapter,
  client: McpClient,
  request: McpCallToolRequest,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onProgress?: McpCallToolOptions["onProgress"],
): Promise<McpToolCallResult> {
  // 工具调用此前完全无日志：超时时既看不到预算是多少，也无法区分"服务端慢"与
  // "客户端预算太小"。这里记录预算与耗时，但只记参数的 key（值可能是用户输入）。
  const logBase = {
    event: "mcp.tool.call",
    mcpServerName: request.serverName,
    mcpToolName: request.toolName,
    module: "adapters.mcp",
    timeoutMs,
  };
  const argumentKeys = Object.keys(request.arguments ?? {}).sort();
  this.logger?.debug("MCP tool call started", {
    ...logBase,
    argumentKeys,
    status: "started",
  });

  const startedAt = Date.now();
  try {
    const result = await client.callTool(
      {
        name: request.toolName,
        arguments: request.arguments ?? {},
        ...(request.trace ||
        request.runtimeScope ||
        request.taskType ||
        request.workspaceKey ||
        request.workspacePath
          ? { _meta: mcpRequestMeta(request) }
          : {}),
      },
      {
        signal,
        timeout: timeoutMs,
        // 进度通知重置超时（A8）：长任务只要持续上报就不会被 timeoutMs 打断；总时长由工具级 _meta.timeoutMs 约束。
        resetTimeoutOnProgress: true,
        ...(onProgress
          ? {
              onprogress: (notification: { progress: number; total?: number; message?: string }) =>
                onProgress({
                  progress: notification.progress,
                  ...(notification.total !== undefined ? { total: notification.total } : {}),
                  ...(notification.message !== undefined ? { message: notification.message } : {}),
                }),
            }
          : {}),
      },
    );

    const durationMs = Date.now() - startedAt;
    const isError = typeof result.isError === "boolean" ? result.isError : false;
    // 官方 MCP 的 in-band 失败（配额耗尽、无套餐）是 HTTP 200 + isError，wrapper 那条
    // 非 2xx warn 覆盖不到；request id 也只有 wrapper 能看到，所以在这里按 span 取回。
    const serverRequestId = this.takeServerRequestId(request.trace?.spanId);
    const outcome = {
      ...logBase,
      contentBlocks: Array.isArray(result.content) ? result.content.length : 0,
      durationMs,
      hasStructuredContent: result.structuredContent !== undefined,
      // 业务级失败（isError）与传输级失败不同，必须能分开统计。
      isError,
      ...(serverRequestId ? { serverRequestId } : {}),
    };
    if (isError) {
      // 之前 in-band 失败只有这条 debug，而生产 logger 最低级别是 Info——等于配额耗尽
      // 这类失败在生产日志里完全不可见。
      this.logger?.warn("MCP tool returned an error", { ...outcome, status: "failed" });
    } else {
      this.logger?.debug("MCP tool call completed", { ...outcome, status: "completed" });
    }

    const meta = isRecord(result._meta) ? result._meta : undefined;
    return {
      content: Array.isArray(result.content)
        ? (result.content as McpContentBlock[])
        : [{ type: "text", text: "" }],
      structuredContent: result.structuredContent,
      isError: typeof result.isError === "boolean" ? result.isError : undefined,
      // 只在失败时附加：成功路径上它是纯噪声。服务端已给的键一律不覆盖。
      _meta:
        isError && serverRequestId
          ? { ...meta, [ZCODE_MCP_SERVER_REQUEST_ID_META_KEY]: serverRequestId }
          : meta,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    // 判定是否为超时：SDK 超时会抛 MCP error code -32001 (RequestTimeout)，
    // 底层 fetch abort 抛 AbortError。两者都要能一眼认出，否则只能看到裸 message。
    const timedOut =
      /timed?\s*out|timeout/i.test(message) ||
      (error instanceof Error && error.name === "AbortError");
    // 传输级失败也带上：4xx/5xx 时 SDK 抛出的 message 里没有 request id。
    const serverRequestId = this.takeServerRequestId(request.trace?.spanId);
    this.logger?.warn("MCP tool call failed", {
      ...logBase,
      argumentKeys,
      durationMs,
      error: message,
      ...(serverRequestId ? { serverRequestId } : {}),
      errorName: error instanceof Error ? error.name : "unknown",
      status: "failed",
      timedOut,
      // 耗时贴着预算 ⇒ 是我们掐断的；远小于预算 ⇒ 是对端或网络断的。
      ...(timedOut ? { budgetExhausted: durationMs >= timeoutMs * 0.9 } : {}),
    });
    throw error;
  }
}

export async function reconnectForCall(
  this: NodeMcpAdapter,
  name: string,
  config: McpServerConfig,
): Promise<void> {
  this.logger?.warn("MCP server reconnecting after lost connection", {
    event: "mcp.server.reconnect.started",
    mcpServerName: name,
    status: "started",
    transport: config.type,
  });
  await this.connectServer(name, config);
}
