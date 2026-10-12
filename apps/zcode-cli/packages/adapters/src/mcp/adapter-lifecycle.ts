// Modified by ZCode Feiyu.
import type { McpServerConfig, McpServerStatus } from "@zcode/contracts";
import { type McpServerFailureKind } from "@zcode/shared";
import { createHash } from "node:crypto";
import type { NodeMcpAdapter } from "./adapter-owner.js";
import {
  McpClient,
  McpServerRecord,
  McpTransport,
  getStdioTransportPid,
} from "./adapter-shared.js";
import { OfficialMcpAuthError } from "./official-auth.js";
import { terminateMcpStdioProcessTree } from "./process-tree.js";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";
import { McpTimeoutError } from "./timeout.js";

export async function close(this: NodeMcpAdapter): Promise<void> {
  const startedAt = Date.now();
  const serverCount = this.records.size;
  for (const name of this.records.keys()) {
    this.nextConnectionGeneration(name);
  }
  await Promise.all(Array.from(this.records.keys()).map((name) => this.closeRecord(name)));
  this.records.clear();
  this.connectionDiagnosticByServer.clear();
  this.logger?.info("MCP adapter closed", {
    durationMs: Date.now() - startedAt,
    event: "mcp.adapter.closed",
    serverCount,
    status: "completed",
  });
}

export async function failConnection(
  this: NodeMcpAdapter,
  input: {
    client?: McpClient;
    config: McpServerConfig;
    connectDurationMs?: number;
    error: unknown;
    failureKind?: McpServerFailureKind;
    generation: number;
    getRecentStderr?: () => string | undefined;
    listToolsDurationMs?: number;
    name: string;
    startedAt: number;
    transport?: McpTransport;
  },
): Promise<McpServerStatus> {
  const {
    client,
    config,
    connectDurationMs,
    error,
    failureKind: fallbackFailureKind,
    generation,
    getRecentStderr,
    listToolsDurationMs,
    name,
    startedAt,
    transport,
  } = input;
  const message = error instanceof Error ? error.message : String(error);
  // 官方 MCP 鉴权失败的稳定分类必须落进日志：failConnection 原先只记
  // error.message，而多数分类并不出现在 message 文本里（只有 auth-port 那条带上了），
  // 导致 official_mcp_origin_untrusted / official_auth_rejected 等在生产日志里 grep 不到。
  const officialAuthKind =
    (error instanceof OfficialMcpAuthError ? error.kind : undefined) ??
    this.lastOfficialAuthKind.get(name);
  this.lastOfficialAuthKind.delete(name);
  const responseDiagnostic = this.connectionDiagnosticByServer.get(name);
  this.connectionDiagnosticByServer.delete(name);
  const failureKind =
    (officialAuthKind === "official_mcp_origin_untrusted"
      ? "official_origin_untrusted"
      : undefined) ??
    responseDiagnostic?.failureKind ??
    (error instanceof McpTimeoutError && fallbackFailureKind !== "tool_list_failed"
      ? "connection_timeout"
      : undefined) ??
    fallbackFailureKind ??
    "connection_failed";
  const displayMessage = responseDiagnostic?.serverRequestId
    ? `${message} - ${responseDiagnostic.serverRequestId}`
    : message;
  const status = this.createStatus(config, "failed", {
    error: displayMessage,
    failureKind,
    ...(responseDiagnostic?.serverRequestId
      ? { serverRequestId: responseDiagnostic.serverRequestId }
      : {}),
  });
  const recentStderr = getRecentStderr?.();
  const mcpTransportPid = getStdioTransportPid(transport);
  await this.closeClientAndTransport(name, client, transport);
  if (!this.isCurrentConnection(name, generation)) {
    return this.records.get(name)?.status ?? status;
  }
  this.records.set(name, { config, status, tools: [] });
  this.logger?.warn("MCP server connection failed", {
    ...this.connectionContext,
    connectDurationMs,
    durationMs: Date.now() - startedAt,
    error: displayMessage,
    event: "mcp.server.failed",
    listToolsDurationMs,
    mcpServerName: name,
    ...(officialAuthKind ? { officialAuthKind } : {}),
    ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
    status: "failed",
    ...(recentStderr ? { stderr: recentStderr } : {}),
    transport: config.type,
  });
  return status;
}

export async function closeRecord(this: NodeMcpAdapter, name: string): Promise<void> {
  const record = this.records.get(name);
  if (!record) return;
  record.abortController?.abort(new Error(`MCP server ${name} connection closed`));
  if (!record.client && !record.transport) return;
  await this.closeClientAndTransport(name, record.client, record.transport);
}

export async function closeClientAndTransport(
  this: NodeMcpAdapter,
  name: string,
  client?: McpClient,
  transport?: McpTransport,
): Promise<void> {
  const startedAt = Date.now();
  const mcpTransportPid = getStdioTransportPid(transport);
  // 主动关闭前先摘掉 connection_lost 监听，避免正常回收被误报为意外断连。
  if (client) client.onclose = undefined;
  // MCP SDK close 只保证直接 stdio 子进程退出，npx/npm wrapper 拉起的 MCP server
  // 或 chrome-devtools-mcp watchdog 可能残留；这里先按进程树显式回收，再走 SDK close 清理协议状态。
  await this.terminateStdioProcessTree(name, transport);

  try {
    await client?.close();
  } catch (error) {
    this.logger?.debug("MCP client close failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.client.close.failed",
      mcpServerName: name,
    });
  }

  try {
    await transport?.close();
  } catch (error) {
    this.logger?.debug("MCP transport close failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.transport.close.failed",
      mcpServerName: name,
    });
  }
  if (
    this.connectionContext &&
    transport instanceof ProcessTreeStdioClientTransport &&
    !transport.processAlive
  ) {
    this.telemetry?.recordProcessClosed({
      connectionId: this.connectionContext.mcpConnectionId,
    });
  }
  this.logger?.info("MCP server closed", {
    ...this.connectionContext,
    durationMs: Date.now() - startedAt,
    event: "mcp.server.closed",
    mcpServerName: name,
    ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
    status: "completed",
  });
}

export async function terminateStdioProcessTree(
  this: NodeMcpAdapter,
  name: string,
  transport?: McpTransport,
): Promise<void> {
  const pid = getStdioTransportPid(transport);
  if (pid == null) return;

  try {
    await terminateMcpStdioProcessTree(pid);
  } catch (error) {
    this.logger?.warn("MCP stdio process tree cleanup failed", {
      ...this.connectionContext,
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.stdio.process_tree_cleanup.failed",
      mcpServerName: name,
      mcpTransportPid: pid,
      pid,
      status: "failed",
    });
  }
}

export function onAppConnectionInvalidated(
  this: NodeMcpAdapter,
  name: string,
  listener: () => void,
): () => void {
  const listeners = this.appConnectionListeners.get(name) ?? new Set();
  listeners.add(listener);
  this.appConnectionListeners.set(name, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) this.appConnectionListeners.delete(name);
  };
}

export function appConnectionSnapshot(
  this: NodeMcpAdapter,
  name: string,
): { identity: string; generation: number } | null {
  const record = this.records.get(name);
  if (!record?.client || record.status.status !== "connected") return null;
  // 只向宿主输出摘要；配置中的凭据不进入协议或日志。属性排序避免配置序列化次序造成换源。
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)]),
      );
    return value;
  };
  return {
    identity: createHash("sha256")
      .update(
        JSON.stringify([
          process.platform,
          process.execPath,
          this.workingDirectory ?? "",
          name,
          canonical(record.config),
        ]),
      )
      .digest("hex"),
    generation: this.connectionGenerations.get(name) ?? 0,
  };
}

export function nextConnectionGeneration(this: NodeMcpAdapter, name: string): number {
  const generation = (this.connectionGenerations.get(name) ?? 0) + 1;
  this.connectionGenerations.set(name, generation);
  // eslint-disable-next-line unicorn/no-useless-spread -- 回调可能增删监听器，本次通知必须固定接收者。
  for (const listener of [...(this.appConnectionListeners.get(name) ?? [])]) listener();
  return generation;
}

export function isCurrentConnection(
  this: NodeMcpAdapter,
  name: string,
  generation: number,
): boolean {
  return this.connectionGenerations.get(name) === generation;
}

export function updateCurrentRecord(
  this: NodeMcpAdapter,
  name: string,
  generation: number,
  patch: Partial<Pick<McpServerRecord, "client" | "transport">>,
): void {
  if (!this.isCurrentConnection(name, generation)) return;
  const record = this.records.get(name);
  if (!record) return;
  Object.assign(record, patch);
}

export function updateCurrentRecordStatus(
  this: NodeMcpAdapter,
  name: string,
  generation: number,
  patch: Partial<McpServerStatus>,
): void {
  if (!this.isCurrentConnection(name, generation)) return;
  const record = this.records.get(name);
  if (!record) return;
  record.status = {
    ...record.status,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

export function createStatus(
  this: NodeMcpAdapter,
  config: McpServerConfig,
  status: McpServerStatus["status"],
  extra: {
    authorization?: McpServerStatus["authorization"];
    error?: string;
    failureKind?: McpServerStatus["failureKind"];
    protocolEra?: McpServerStatus["protocolEra"];
    serverRequestId?: string;
    toolCount?: number;
  } = {},
): McpServerStatus {
  return {
    status,
    transport: config.type,
    toolCount: extra.toolCount ?? 0,
    updatedAt: new Date().toISOString(),
    authorization: extra.authorization,
    error: extra.error,
    failureKind: extra.failureKind,
    protocolEra: extra.protocolEra,
    serverRequestId: extra.serverRequestId,
  };
}
