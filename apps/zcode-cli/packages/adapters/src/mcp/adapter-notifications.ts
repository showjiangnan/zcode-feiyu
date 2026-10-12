// Modified by ZCode Feiyu.
import type { McpToolDescriptor } from "@zcode/contracts";
import { ZCODE_OFFICIAL_MCP_AUTH_TYPE } from "@zcode/shared";
import type { NodeMcpAdapter } from "./adapter-owner.js";
import {
  MCP_NOTIFICATION_MESSAGE,
  MCP_NOTIFICATION_RESOURCES_LIST_CHANGED,
  MCP_NOTIFICATION_RESOURCES_UPDATED,
  MCP_NOTIFICATION_TOOLS_LIST_CHANGED,
  McpClient,
  McpServerRecord,
  isSupportedElicitationMode,
} from "./adapter-shared.js";
import { normalizeMcpToolDescriptor } from "./descriptor.js";
import { waitWithinMcpDeadline, type McpDeadline } from "./timeout.js";

export function toolListRevision(this: NodeMcpAdapter): number {
  return this.toolListRevisionCounter;
}

export async function listTools(this: NodeMcpAdapter): Promise<McpToolDescriptor[]> {
  // 收到 notifications/tools/list_changed 的 server 在下一次 listTools 时重新拉取
  // （runtime 只在回合开始前调用，回合内工具表不变）。
  for (const [name, record] of this.records) {
    if (!record.toolsStale || !record.client || record.status.status !== "connected") continue;
    try {
      const listed = await record.client.listTools();
      record.tools = listed.tools.map((tool) =>
        normalizeMcpToolDescriptor(
          name,
          tool,
          record.config.timeoutMs,
          record.config.type === "http" &&
            record.config.auth?.type === ZCODE_OFFICIAL_MCP_AUTH_TYPE,
        ),
      );
      record.status = { ...record.status, toolCount: record.tools.length };
      record.toolsStale = false;
      this.logger?.info("MCP tool list refreshed after list_changed", {
        event: "mcp.tools.refreshed",
        mcpServerName: name,
        toolCount: record.tools.length,
      });
    } catch (error) {
      this.logger?.warn("MCP tool list refresh failed", {
        event: "mcp.tools.refresh_failed",
        mcpServerName: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return Array.from(this.records.values()).flatMap((record) => record.tools);
}

export function installNotificationHandlers(
  this: NodeMcpAdapter,
  client: McpClient,
  serverName: string,
): void {
  const setNotificationHandler = (client as unknown as { setNotificationHandler?: unknown })
    .setNotificationHandler;
  if (typeof setNotificationHandler !== "function") return;
  // SDK 2.x：第一个参数是通知方法名（spec 方法直接用字符串），schema 是可选的第二个参数。
  const typed = client as unknown as {
    setNotificationHandler(method: string, handler: (notification: unknown) => void): void;
  };
  typed.setNotificationHandler(MCP_NOTIFICATION_TOOLS_LIST_CHANGED, () => {
    const record = this.records.get(serverName);
    if (record) record.toolsStale = true;
    this.toolListRevisionCounter += 1;
    this.notifications?.onNotification({ kind: "toolListChanged", serverName });
  });
  typed.setNotificationHandler(MCP_NOTIFICATION_RESOURCES_UPDATED, (notification) => {
    const uri = (notification as { params?: { uri?: unknown } }).params?.uri;
    if (typeof uri !== "string") return;
    this.notifications?.onNotification({
      kind: "resourceUpdated",
      serverName,
      uri,
      subscribers: this.resourceSubscriptions.subscribers(serverName, uri),
    });
  });
  typed.setNotificationHandler(MCP_NOTIFICATION_RESOURCES_LIST_CHANGED, () => {
    this.notifications?.onNotification({
      kind: "resourceListChanged",
      serverName,
      subscribers: this.resourceSubscriptions.allSubscribers(serverName),
    });
  });
  typed.setNotificationHandler(MCP_NOTIFICATION_MESSAGE, (notification) => {
    const params = (notification as { params?: Record<string, unknown> }).params ?? {};
    this.notifications?.onNotification({
      kind: "loggingMessage",
      serverName,
      level: typeof params.level === "string" ? params.level : "info",
      ...(typeof params.logger === "string" ? { logger: params.logger } : {}),
      data: params.data,
    });
  });
}

export async function resolveConnectedRecord(
  this: NodeMcpAdapter,
  serverName: string,
  deadline: McpDeadline,
  timeoutMessage: string,
  signal: AbortSignal | undefined,
): Promise<McpServerRecord & { client: McpClient }> {
  const pending = this.records.get(serverName)?.connecting;
  if (pending) {
    // 修复原因：connecting 是 adapter 持有的共享连接/OAuth 恢复任务。过去这里裸 await，
    // tool caller 的 timeout/abort 完全失效；但直接 abort 底层任务又会关闭其他 caller 共用的
    // callback listener。这里只限制当前 waiter，共享任务继续由 record 生命周期持有。
    await waitWithinMcpDeadline(pending, deadline, timeoutMessage, signal);
  }

  // Bugfix：stdio MCP 子进程死亡后（如 node_repl 被异步错误击穿），此前没有任何恢复路径：
  // 连接只在 session 创建时建立一次，session resume 也不重建，该会话的工具从此永远失败。
  // 这里在调用前对已断连的 record 重连一次；server 进程内状态（如 REPL 变量）不可恢复，
  // 但工具本身恢复可用。
  const disconnected = this.records.get(serverName);
  if (disconnected && disconnected.status.status === "disconnected") {
    await waitWithinMcpDeadline(
      this.reconnectForCall(serverName, disconnected.config),
      deadline,
      timeoutMessage,
      signal,
    );
  }

  const record = this.records.get(serverName);
  if (!record?.client || record.status.status !== "connected") {
    throw new Error(`MCP server is not connected: ${serverName}`);
  }
  return record as McpServerRecord & { client: McpClient };
}

export function installElicitationHandler(
  this: NodeMcpAdapter,
  client: McpClient,
  serverName: string,
): void {
  const port = this.elicitation;
  const setRequestHandler = (client as unknown as { setRequestHandler?: unknown })
    .setRequestHandler;
  if (!port || typeof setRequestHandler !== "function") return;
  (
    client as unknown as {
      setRequestHandler(
        method: "elicitation/create",
        handler: (request: {
          params: { message: string; requestedSchema?: unknown };
        }) => Promise<unknown>,
      ): void;
    }
  ).setRequestHandler("elicitation/create", async (request) => {
    // 接受缺省 / "form" / 兼容接口的 "openai/form" / "openaiForm"；url 等其它模式 decline。
    const mode = (request.params as { mode?: unknown }).mode;
    if (!isSupportedElicitationMode(mode)) {
      this.logger?.warn("MCP elicitation mode not supported, declining", {
        event: "mcp.elicitation.unsupported_mode",
        mcpServerName: serverName,
        mode: String(mode),
      });
      return { action: "decline" };
    }
    const trace = this.activeCallTraces.get(serverName);
    const result = await port.requestElicitation({
      serverName,
      message: request.params.message,
      requestedSchema: request.params.requestedSchema,
      ...(trace ? { trace } : {}),
    });
    return result.action === "accept"
      ? { action: "accept", content: result.content ?? {} }
      : { action: result.action };
  });
}
