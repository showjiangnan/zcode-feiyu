// Modified by ZCode Feiyu contributors (2026).
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ComputerUseRuntime, ComputerUseRuntimeContext } from "@zcode/zcode-cua";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "@zcode/zcode-cua/host-display-contract";
import type { NodeReplRunResult } from "@zcode/core/repl";
import type { Logger } from "@zcode/contracts";
import { requestContext, type NodeReplCuaBrokerConnection } from "./cua-bridge.js";

const MAX_REQUEST_BYTES = 1024 * 1024;

export interface NodeReplCuaBroker {
  connection: NodeReplCuaBrokerConnection;
  admit(meta: Record<string, unknown>):
    | {
        connection: NodeReplCuaBrokerConnection;
        release(): void;
        project(run: NodeReplRunResult): NodeReplRunResult;
      }
    | undefined;
  ready: Promise<void>;
  close(): Promise<void>;
}

export function createNodeReplCuaBroker(input: {
  runtime: ComputerUseRuntime;
  logger?: Logger;
  platform?: NodeJS.Platform | string;
}): NodeReplCuaBroker {
  const socketPath =
    input.platform === "win32"
      ? `\\\\.\\pipe\\zcode-node-repl-cua-${randomUUID()}`
      : join(tmpdir(), `znrc-${randomUUID()}.sock`);
  const token = randomBytes(32).toString("hex");
  const tickets = new Map<
    string,
    {
      context: ComputerUseRuntimeContext;
      controllers: Set<AbortController>;
      results: unknown[];
      bytes: number;
    }
  >();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (sockets.size >= 64) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(120_000, () => socket.destroy());
    void handleSocket(socket, input.runtime, tickets).catch((error) => {
      input.logger?.warn("Node REPL CUA broker request failed", {
        event: "node_repl.cua_broker.request.failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  server.on("error", (error) => {
    input.logger?.error("Node REPL CUA broker failed", error, {
      event: "node_repl.cua_broker.failed",
    });
  });
  server.listen(socketPath);
  server.unref();
  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", () => {
      if (input.platform === "win32") resolve();
      else void chmod(socketPath, 0o600).then(resolve, reject);
    });
    server.once("error", reject);
  });
  return {
    connection: { socketPath, token },
    ready,
    admit(meta) {
      let context: ComputerUseRuntimeContext;
      try {
        context = parseContext(requestContext(structuredClone(meta)));
      } catch (error) {
        // 资格只控制 CUA 票据；shared REPL 的普通 JS/Browser 不能被 CUA admission 拒绝连带关闭。
        const code = (error as { code?: string }).code;
        if (
          code === "context_missing" ||
          code === "child_task_denied" ||
          code === "subagent_not_allowed" ||
          code === "remote_workspace_unavailable"
        )
          return undefined;
        throw error;
      }
      const ticket = randomBytes(32).toString("hex");
      const entry = {
        context,
        controllers: new Set<AbortController>(),
        results: [] as unknown[],
        bytes: 0,
      };
      tickets.set(ticket, entry);
      return {
        connection: { socketPath, token: ticket },
        project(run) {
          const structuredResults = (run.structuredResults || []).filter(
            (result) =>
              !JSON.stringify(result).includes("zcode-cua-image-ref:") &&
              !JSON.stringify(result).includes("zcode.cua/"),
          );
          const cuaApps = entry.results.flatMap((result) => {
            const primary = (
              result as {
                _meta?: Record<string, { primary?: { appKey?: string; displayName?: string } }>;
              }
            )._meta?.[CUA_APP_ASSOCIATIONS_META_KEY]?.primary;
            return primary?.appKey
              ? [{ appKey: primary.appKey, displayName: primary.displayName }]
              : [];
          });
          // Worker 结果是模型可写的，控制图片和应用身份必须从外层可信 broker 原始回执重建。
          return {
            ...run,
            structuredResults: [
              ...structuredResults,
              ...(entry.results as NonNullable<NodeReplRunResult["structuredResults"]>),
            ],
            cuaApp: cuaApps.at(-1),
          };
        },
        release() {
          tickets.delete(ticket);
          for (const controller of entry.controllers) controller.abort();
        },
      };
    },
    close: async () => {
      tickets.clear();
      for (const socket of sockets) socket.destroy();
      await ready.catch(() => undefined);
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      if (input.platform !== "win32") await rm(socketPath, { force: true });
    },
  };
}

async function handleSocket(
  socket: Socket,
  runtime: ComputerUseRuntime,
  tickets: Map<
    string,
    {
      context: ComputerUseRuntimeContext;
      controllers: Set<AbortController>;
      results: unknown[];
      bytes: number;
    }
  >,
): Promise<void> {
  const abortController = new AbortController();
  let completed = false;
  let requestId: string | undefined;
  let entry:
    | {
        context: ComputerUseRuntimeContext;
        controllers: Set<AbortController>;
        results: unknown[];
        bytes: number;
      }
    | undefined;
  socket.on("error", () => {
    if (!completed) abortController.abort();
  });
  socket.once("close", () => {
    if (!completed) abortController.abort();
  });
  try {
    const raw = await readLine(socket, abortController.signal);
    const payload = JSON.parse(raw) as {
      id?: unknown;
      token?: unknown;
      method?: unknown;
      input?: unknown;
      context?: unknown;
    };
    if (typeof payload.id !== "string" || typeof payload.method !== "string") {
      throw Object.assign(new Error("Computer Use broker request is invalid"), {
        code: "invalid_request",
      });
    }
    // 资格失败也要关联原请求；旧顺序先查 ticket，导致 id=null 掩盖真正的撤销原因。
    requestId = payload.id;
    entry = typeof payload.token === "string" ? tickets.get(payload.token) : undefined;
    if (!entry)
      throw Object.assign(new Error("Computer Use cell credential has expired"), {
        code: "cell_expired",
      });
    entry.controllers.add(abortController);
    // 必须在原生副作用前预留最大回执空间，不能先执行再因媒体上限丢失动作结果。
    if (entry.results.length >= 32 || entry.bytes + 32 * 1024 * 1024 > 64 * 1024 * 1024)
      throw new Error("Computer control cell result limit exceeded; start the next cell");
    // 模型可读 Worker 内的临时凭据，但不能改写由 MCP admission 固定的线程/回合/作用域。
    const context = entry.context;
    const result = await runtime.execute({
      // 这里把 capability method 适配到 staging runtime 的内部 handler；
      // 外层 SDK/bridge 不再构造或调用 MCP tool envelope。
      toolName: payload.method as never,
      arguments: payload.input,
      context,
      signal: abortController.signal,
    });
    entry.results.push(result);
    entry.bytes += Buffer.byteLength(JSON.stringify(result));
    completed = true;
    if (socket.writable) socket.end(`${JSON.stringify({ id: payload.id, ok: true, result })}\n`);
  } catch (error) {
    completed = true;
    if (socket.writable) {
      const value = error as { code?: unknown; message?: unknown };
      socket.end(
        `${JSON.stringify({
          id: requestId ?? null,
          ok: false,
          error: {
            code: typeof value?.code === "string" ? value.code : "broker_error",
            message: typeof value?.message === "string" ? value.message : String(error),
          },
        })}\n`,
      );
    }
  } finally {
    entry?.controllers.delete(abortController);
  }
}

function parseContext(value: unknown): ComputerUseRuntimeContext {
  if (!value || typeof value !== "object")
    throw new Error("Computer Use request context is missing");
  const context = value as Record<string, unknown>;
  if (context.runtimeScope !== "main" && context.runtimeScope !== "subagent")
    throw new Error("Computer Use request scope is missing or invalid");
  if (typeof context.sessionId !== "string" || !context.sessionId.trim()) {
    throw new Error("Computer Use request context is missing sessionId");
  }
  const workspacePath = typeof context.workspacePath === "string" ? context.workspacePath : "";
  const workspaceIdentity =
    typeof context.workspaceIdentity === "string" ? context.workspaceIdentity.trim() : "";
  const workspaceKey =
    workspaceIdentity ||
    workspacePath ||
    (typeof context.workspaceKey === "string" ? context.workspaceKey.trim() : "");
  if (!workspaceKey) throw new Error("Computer Use request context is missing workspaceKey");
  return {
    sessionId: context.sessionId,
    runtimeScope: context.runtimeScope === "subagent" ? "subagent" : "main",
    ...(typeof context.taskType === "string" ? { taskType: context.taskType } : {}),
    workspaceKey,
    ...(workspacePath ? { workspacePath } : {}),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(typeof context.remoteSessionId === "string"
      ? { remoteSessionId: context.remoteSessionId }
      : {}),
    ...(typeof context.turnId === "string" ? { turnId: context.turnId } : {}),
    ...(context.clientMode === "web-remote-replayable" ||
    context.clientMode === "desktop-continuous"
      ? { clientMode: context.clientMode }
      : {}),
    ...(context.deliveryKind === "web-remote-replayable" ||
    context.deliveryKind === "desktop-continuous"
      ? { deliveryKind: context.deliveryKind }
      : {}),
    ...(context.trace && typeof context.trace === "object"
      ? { trace: context.trace as ComputerUseRuntimeContext["trace"] }
      : {}),
  };
}

async function readLine(socket: Socket, signal: AbortSignal): Promise<string> {
  return await new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let bytes = 0;
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      buffer += decoder.write(chunk);
      if (bytes > MAX_REQUEST_BYTES) {
        cleanup();
        reject(new Error("Computer Use broker request exceeded 1 MiB"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(buffer.slice(0, newline));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
