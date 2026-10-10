// Modified by ZCode Feiyu contributors (2026).
import { createComputerUseSDK } from "@zcode/zcode-cua/sdk";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { NodeReplCuaAppIdentity, NodeReplRequestMeta, NodeReplSession } from "@zcode/core";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "@zcode/zcode-cua/host-display-contract";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const NODE_REPL_CUA_BRIDGE_SYMBOL = Symbol.for("zcode.node-repl.computer-use-bridge");
export const CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE = "Computer Use is not available in subagent";
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface ActiveCuaNodeReplCall {
  generation: number;
  requestMeta: NodeReplRequestMeta;
  broker?: NodeReplCuaBrokerConnection;
  signal: AbortSignal;
}

export interface NodeReplCuaBrokerConnection {
  socketPath: string;
  token: string;
}

export interface ComputerUseRuntimeBridge {
  /** 私有 capability 请求；这里不是 MCP tool 调用，MCP 只承载外层 node_repl。 */
  call(method: string, input: unknown): Promise<CallToolResult>;
  assertAvailable(): void;
  documentationRoot: string;
}

export function createComputerUseBridgeGlobals(input: {
  broker?: NodeReplCuaBrokerConnection;
  generation: number;
  getActiveCall: () => ActiveCuaNodeReplCall | undefined;
  session: () => NodeReplSession;
  documentationRoot: string;
}): Record<PropertyKey, unknown> {
  const assertActive = (expected?: ActiveCuaNodeReplCall): ActiveCuaNodeReplCall => {
    const active = input.getActiveCall();
    if (!active || active.generation !== input.generation || (expected && active !== expected)) {
      throw cuaBindingError(
        "stale_binding",
        "Computer Control binding expired after a kernel reset; initialize and observe again",
      );
    }
    return active;
  };
  const assertAvailable = (): ActiveCuaNodeReplCall => {
    const active = assertActive();
    if (active.requestMeta.runtime_scope === "subagent") {
      throw cuaBindingError("subagent_not_allowed", CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE);
    }
    // 缺失 turn/session 也曾变成笼统 unavailable；先检查可信上下文，保留实际阻断原因。
    requestContext(active.requestMeta);
    if (!(active.broker || input.broker)) {
      throw cuaBindingError(
        "binding_unavailable",
        "Computer Control is not connected to this task. Check Computer Control settings and the local host connection; application control has not started.",
      );
    }
    return active;
  };

  const bridge: ComputerUseRuntimeBridge = {
    documentationRoot: input.documentationRoot,
    assertAvailable: () => {
      assertAvailable();
    },
    call: async (method, methodInput) => {
      const active = assertAvailable();
      const result = await sendCuaBrokerRequest(
        (active.broker || input.broker)!,
        {
          method,
          input: methodInput,
          context: requestContext(active.requestMeta),
        },
        active.signal,
      );
      // generation 标识 kernel，仍需当次 cell 身份，防止旧回执进入新 cell 的 sink。
      assertActive(active);
      if (result.responseMeta) input.session().mergeResponseMeta(result.responseMeta);
      // 目标应用身份必须在这里取：broker 响应是模型看不见也改不了的一跳。等到
      // `projectToHost` 把 `_meta` 交给 `nodeRepl.emitStructuredResult` 就已经落在模型可写的
      // sandbox 通道上，无法再区分「producer 给的」和「cell 里自己写的」。
      const app = readPrimaryAppIdentity(result.result);
      if (app) input.session().recordCuaAppIdentity(app);
      if (!result.result.isError) input.session().publishComputerControlResult(result.result);
      return result.result;
    },
  };

  return { [NODE_REPL_CUA_BRIDGE_SYMBOL]: bridge, cua: createComputerUseSDK(bridge) };
}

/**
 * 从 producer 的 app-associations 元数据里取出单一目标应用。
 *
 * 只读 `primary`：`list_apps` 用的是 `items` 模式（按结果下标关联，node_repl 下没有逐条列表卡），
 * `request_access` / `stop_computer_control` 声明 `none`，这三者都不该覆盖同一 cell 里前面动作
 * 已经确立的身份。producer 自带的内联 icon PNG 刻意不取：会话协议不承载图标字节，UI 按
 * appKey 派生 locator 后交平台服务解析。
 */
function readPrimaryAppIdentity(result: CallToolResult): NodeReplCuaAppIdentity | undefined {
  const meta = result._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const associations = (meta as Record<string, unknown>)[CUA_APP_ASSOCIATIONS_META_KEY];
  if (!associations || typeof associations !== "object" || Array.isArray(associations)) {
    return undefined;
  }
  const primary = (associations as { primary?: unknown }).primary;
  if (!primary || typeof primary !== "object" || Array.isArray(primary)) return undefined;
  const { appKey, displayName } = primary as { appKey?: unknown; displayName?: unknown };
  if (typeof appKey !== "string" || !appKey.trim()) return undefined;
  return {
    appKey: appKey.trim(),
    ...(typeof displayName === "string" && displayName.trim()
      ? { displayName: displayName.trim() }
      : {}),
  };
}

export function requestContext(meta: NodeReplRequestMeta): Record<string, unknown> {
  const stringMeta = (key: string): string | undefined => {
    const value = meta[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  if (meta.runtime_scope === "subagent")
    throw cuaBindingError("subagent_not_allowed", CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE);
  if (meta.runtime_scope !== "main")
    throw cuaBindingError(
      "context_missing",
      "Computer Control requires trusted main runtime_scope metadata",
    );
  const sessionId = stringMeta("session_id");
  if (stringMeta("task_type")?.endsWith("_child"))
    throw cuaBindingError(
      "child_task_denied",
      "Computer Control is available only to the top-level main task",
    );
  if (stringMeta("remote_session_id"))
    throw cuaBindingError(
      "remote_workspace_unavailable",
      "Computer Control is unavailable for a remote workspace",
    );
  if (!sessionId)
    throw cuaBindingError(
      "context_missing",
      "Computer Control requires trusted session_id metadata",
    );
  const turnId = stringMeta("turn_id");
  if (!turnId)
    throw cuaBindingError("context_missing", "Computer Control requires trusted turn_id metadata");
  const workspacePath = stringMeta("workspace_path");
  const workspaceIdentity = stringMeta("workspace_identity");
  const workspaceKey = stringMeta("workspace_key") ?? workspaceIdentity ?? workspacePath;
  if (!workspaceKey)
    throw cuaBindingError(
      "context_missing",
      "Computer Control requires trusted workspace metadata",
    );
  const clientMode = stringMeta("client_mode") ?? "desktop-continuous";
  const deliveryKind = stringMeta("delivery_kind") ?? clientMode;
  return {
    runtimeScope: "main",
    ...(stringMeta("task_type") ? { taskType: stringMeta("task_type") } : {}),
    sessionId,
    ...(workspacePath ? { workspacePath } : {}),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    workspaceKey,
    ...(stringMeta("remote_session_id")
      ? { remoteSessionId: stringMeta("remote_session_id") }
      : {}),
    turnId,
    clientMode,
    deliveryKind,
    ...(stringMeta("trace_id")
      ? {
          trace: {
            traceId: stringMeta("trace_id"),
            ...(stringMeta("span_id") ? { spanId: stringMeta("span_id") } : {}),
            ...(stringMeta("parent_span_id") ? { parentSpanId: stringMeta("parent_span_id") } : {}),
          },
        }
      : {}),
  };
}

function cuaBindingError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { name: "CuaError", code });
}

async function sendCuaBrokerRequest(
  broker: NodeReplCuaBrokerConnection,
  request: { method: string; input: unknown; context: Record<string, unknown> },
  signal: AbortSignal,
): Promise<{ result: CallToolResult; responseMeta?: Record<string, unknown> }> {
  const id = randomUUID();
  return await new Promise((resolve, reject) => {
    const socket = createConnection(broker.socketPath);
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let bytes = 0;
    let settled = false;
    const finish = (
      error?: unknown,
      value?: { result: CallToolResult; responseMeta?: Record<string, unknown> },
    ) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error("Computer Use broker returned no response"));
    };
    const onAbort = () => finish(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, token: broker.token, ...request })}\n`);
    });
    socket.on("data", (chunk) => {
      // socket 是字节流；中文/Emoji 可跨 chunk，逐包 toString 会不可逆地替换字符。
      bytes += chunk.length;
      buffer += decoder.write(chunk);
      if (bytes > MAX_RESPONSE_BYTES) {
        finish(new Error("Computer Use broker response exceeded the 32 MiB limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const payload = JSON.parse(buffer.slice(0, newline)) as {
          id?: unknown;
          ok?: unknown;
          error?: unknown;
          result?: CallToolResult;
          responseMeta?: Record<string, unknown>;
        };
        if (payload.id !== id) throw new Error("Computer Use broker response id mismatch");
        if (payload.ok !== true) {
          const error =
            payload.error && typeof payload.error === "object"
              ? (payload.error as { code?: unknown; message?: unknown })
              : undefined;
          throw cuaBindingError(
            typeof error?.code === "string" ? error.code : "broker_error",
            typeof error?.message === "string"
              ? error.message
              : typeof payload.error === "string"
                ? payload.error
                : "Computer Control broker failed",
          );
        }
        if (!payload.result) throw new Error("Computer Use broker returned no result");
        finish(undefined, { result: payload.result, responseMeta: payload.responseMeta });
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", finish);
    socket.once("close", () => {
      if (!settled) finish(new Error("Computer Use broker closed before returning a response"));
    });
    if (signal.aborted) onAbort();
  });
}
