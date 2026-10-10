// Modified by ZCode Feiyu contributors (2026).
/* eslint-disable max-lines -- shared node_repl host 的 worker、CUA bridge 和生命周期必须保持同一边界。 */
import { resolve } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { INVALID_PARAMS, Server, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { JsInputJsonSchema } from "@zcode/contracts/tools/node-repl";
// 值导入必须走 @zcode/core/repl 这条深路径：barrel 会把 core 的整张图拖进 bundle
// （tool handlers → @zcode/dynamic-workflow → typescript，实测 21.7MB 且求值即崩
// ERR_AMBIGUOUS_MODULE_SYNTAX）。宿主只需要 REPL 会话本身。
// 类型也一并从 /repl 取：总入口的顶层副作用会把 Agent、Bash 注册表和工作流编译器
// 打入每个 REPL Worker，Worker 会重复承担这份开销。
import {
  NodeReplSession,
  type NodeReplRequestMeta,
  type NodeReplRunResult,
} from "@zcode/core/repl";
import { createComputerUseRuntime, type ComputerUseRuntime } from "@zcode/zcode-cua";
import { z } from "zod";
import { createBrowserBridgeGlobals, type ActiveNodeReplCall } from "./browser-bridge.js";
import {
  createComputerUseBridgeGlobals,
  type ActiveCuaNodeReplCall,
  type NodeReplCuaBrokerConnection,
} from "./cua-bridge.js";
import { createNodeReplCuaBroker, type NodeReplCuaBroker } from "./cua-broker.js";
import {
  isDirectMcpEntrypoint,
  installNodeReplProcessGuards,
  installNodeReplShutdownTriggers,
} from "./process-lifecycle.js";
import { toMcpRunResult } from "./result.js";
import {
  JS_TOOL_DESCRIPTION,
  NODE_REPL_DEFAULT_TIMEOUT_MS,
  NODE_REPL_SERVER_INSTRUCTIONS,
  NODE_REPL_SERVER_VERSION,
} from "./tool-contract.js";

const MAX_SYNC_TIMEOUT_MS = 120_000;
const UNTRUSTED_SESSION_KEY = "__unscoped__";
const WORKER_KIND = "zcode-node-repl-call";
export const NODE_REPL_MCP_PROCESS_TITLE = "zcode-node-repl-mcp";
const pluginRoot = process.env.ZCODE_PLUGIN_ROOT ?? process.cwd();
// CUA 与 Browser Use 共用 node_repl host，但文档和 native 依赖必须按领域隔离；
// 否则 CUA skill 会因为 host root 恰好来自 Browser Use 而再次产生隐式依赖。
const browserDocumentationRoot = resolve(pluginRoot, "docs");
const cuaDocumentationRoot = resolve(process.env.ZCODE_CUA_PLUGIN_ROOT ?? pluginRoot, "docs");
const jsInputSchema = z
  .object({
    code: z.string(),
    timeout_ms: z.number().int().min(1).max(MAX_SYNC_TIMEOUT_MS).optional(),
    // tools/list 对新调用强制 title，但执行层必须继续接受旧 provider 和历史回放的 code-only 输入。
    title: z.string().min(1).max(120).optional(),
  })
  .strict();
const requestContextSchema = z
  .object({
    parent_span_id: z.string().optional(),
    runtime_scope: z.enum(["main", "subagent"]).optional(),
    task_type: z.string().optional(),
    session_id: z.string().trim().min(1).optional(),
    span_id: z.string().optional(),
    trace_id: z.string().optional(),
    turn_id: z.string().optional(),
    workspace_identity: z.string().optional(),
    workspace_key: z.string().optional(),
    workspace_path: z.string().optional(),
    remote_session_id: z.string().optional(),
    client_mode: z.string().optional(),
    delivery_kind: z.string().optional(),
  })
  .passthrough();

const tools: Tool[] = [
  {
    name: "js",
    description: JS_TOOL_DESCRIPTION,
    // host MCP 曾手写出 title optional 的模型合同，和 built-in 合同分叉后 UI 只能显示固定完成文案。
    inputSchema: JsInputJsonSchema as Tool["inputSchema"],
  },
];

export interface NodeReplExecuteInput {
  code: string;
  requestMeta: NodeReplRequestMeta;
  signal: AbortSignal;
  syncTimeoutMs: number;
  cuaBroker?: NodeReplCuaBrokerConnection;
}

export type NodeReplExecutor = (input: NodeReplExecuteInput) => Promise<NodeReplRunResult>;

export interface NodeReplMcpRuntime {
  dispose(): void;
  server: Server;
}

interface WorkerCallData {
  code: string;
  kind: typeof WORKER_KIND;
  requestMeta: NodeReplRequestMeta;
  syncTimeoutMs: number;
  cuaBroker?: NodeReplCuaBrokerConnection;
}

export function setNodeReplMcpProcessTitle(target: { title: string } = process): void {
  target.title = NODE_REPL_MCP_PROCESS_TITLE;
}

/**
 * 测试与同进程嵌入入口使用同一条执行逻辑；生产 stdio 默认在一次性 Worker 中调用它，
 * 从而连 Node 的模块缓存也随调用一起销毁。
 */
export function createInProcessNodeReplExecutor(): NodeReplExecutor {
  let activeCall: ActiveNodeReplCall | undefined;
  let activeCuaCall: ActiveCuaNodeReplCall | undefined;
  let session: NodeReplSession | undefined;
  let generation = Date.now();
  return async (input) => {
    if (!session) {
      generation++;
      session = new NodeReplSession({
        injectedGlobals: () => ({
          ...createBrowserBridgeGlobals({
            documentationRoot: browserDocumentationRoot,
            generation,
            getActiveCall: () => activeCall,
            session: () => session!,
          }),
          ...createComputerUseBridgeGlobals({
            generation,
            getActiveCall: () => activeCuaCall,
            session: () => session!,
            documentationRoot: cuaDocumentationRoot,
          }),
        }),
        restrictProcess: true,
      });
    }
    // NodeReplApi 的公开 metadata 副本不能改写控制桥接的可信 admission。
    const requestMeta = Object.freeze(structuredClone(input.requestMeta));
    activeCall = { generation, requestMeta, signal: input.signal };
    activeCuaCall = { generation, requestMeta, signal: input.signal, broker: input.cuaBroker };
    try {
      return await session.run(input.code, {
        requestMeta: { ...requestMeta },
        signal: input.signal,
        syncTimeoutMs: input.syncTimeoutMs,
      });
    } finally {
      activeCall = undefined;
      activeCuaCall = undefined;
      if (input.signal.aborted) {
        session.dispose();
        session = undefined;
      }
    }
  };
}

export function createNodeReplMcpRuntime(
  input: { executeJs?: NodeReplExecutor; cuaRuntime?: ComputerUseRuntime } = {},
): NodeReplMcpRuntime {
  const kernels = new Map<string, { worker: Worker; busy: boolean; touched: number }>();
  const executeJs = input.executeJs ?? ((call) => executeJsInWorker(call, kernels));
  const cuaRuntime = input.cuaRuntime ?? captureComputerUseRuntimeFromEnvironment();
  const cuaBroker = cuaRuntime
    ? createNodeReplCuaBroker({ runtime: cuaRuntime, platform: process.platform })
    : undefined;
  const queues = new Map<string, Promise<void>>();
  const activeCalls = new Set<AbortController>();
  let disposed = false;

  const serialized = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    queues.set(key, next);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (queues.get(key) === next) queues.delete(key);
    }
  };

  const server = new Server(
    { name: "node_repl", version: NODE_REPL_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: NODE_REPL_SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler("tools/list", async () => ({ tools }));
  server.setRequestHandler("tools/call", async (request, extra) => {
    if (disposed) throw new Error("node_repl runtime is disposed");
    const name = request.params.name;
    const requestMeta = buildRequestMeta(extra.mcpReq._meta);
    const sessionKey = requestSessionKey(requestMeta);
    if (name === "js") {
      const args = parseToolInput(jsInputSchema, request.params.arguments, name);
      return await serialized(sessionKey, async () => {
        if (!args.code) {
          return {
            content: [{ type: "text" as const, text: "js expects non-empty JavaScript source" }],
            isError: true,
          };
        }
        const callController = new AbortController();
        activeCalls.add(callController);
        const timeoutMs = args.timeout_ms ?? NODE_REPL_DEFAULT_TIMEOUT_MS;
        const callMeta: NodeReplRequestMeta = {
          ...requestMeta,
          ...(args.title ? { title: args.title } : {}),
        };
        let admission: ReturnType<NodeReplCuaBroker["admit"]> | undefined;
        try {
          const signal = AbortSignal.any([
            extra.mcpReq.signal,
            callController.signal,
            AbortSignal.timeout(timeoutMs),
          ]);
          if (cuaBroker && callMeta.session_id && callMeta.turn_id) {
            await cuaBroker.ready;
            admission = cuaBroker.admit(callMeta);
          }
          const run = await executeJs({
            code: args.code,
            requestMeta: callMeta,
            signal,
            syncTimeoutMs: Math.min(timeoutMs, MAX_SYNC_TIMEOUT_MS),
            cuaBroker: admission?.connection,
          });
          return toMcpRunResult(admission ? admission.project(run) : run);
        } catch (error) {
          // 宿主/执行异常也必须成为结构化失败工具结果，不能被框架转成无 code 的 internal error。
          const value = error as { name?: unknown; message?: unknown; code?: unknown };
          return toMcpRunResult({
            logs: "",
            error: {
              name: typeof value?.name === "string" ? value.name : "Error",
              message: typeof value?.message === "string" ? value.message : String(error),
              ...(typeof value?.code === "string" ? { code: value.code } : {}),
            },
          });
        } finally {
          admission?.release();
          activeCalls.delete(callController);
        }
      });
    }
    invalidParams(`Tool ${name} not found`);
  });

  return {
    server,
    dispose: () => {
      disposed = true;
      for (const controller of activeCalls) controller.abort();
      activeCalls.clear();
      queues.clear();
      for (const kernel of kernels.values()) void kernel.worker.terminate();
      kernels.clear();
      void cuaBroker?.close();
      void cuaRuntime?.dispose();
    },
  };
}

async function executeJsInWorker(
  input: NodeReplExecuteInput,
  kernels: Map<string, { worker: Worker; busy: boolean; touched: number }>,
): Promise<NodeReplRunResult> {
  if (input.signal.aborted) throw input.signal.reason;
  const key = requestSessionKey(input.requestMeta);
  let kernel = kernels.get(key);
  if (!kernel) {
    if (kernels.size >= 16) {
      const idle = [...kernels.entries()]
        .filter(([, value]) => !value.busy)
        .sort((a, b) => a[1].touched - b[1].touched)[0];
      if (!idle) throw new Error("All node_repl kernels are busy");
      kernels.delete(idle[0]);
      await idle[1].worker.terminate();
    }
    const env = { ...process.env };
    for (const name of Object.keys(env))
      if (
        /^ZCODE_CUA_(BROKER_TOKEN|PLUGIN_AUTHORITY|PERMISSION_BROKER_SOCKET|LOCAL_UI_TOKEN)$/.test(
          name,
        )
      )
        delete env[name];
    const worker = new Worker(new URL(import.meta.url), { workerData: { kind: WORKER_KIND }, env });
    kernel = { worker, busy: false, touched: Date.now() };
    kernels.set(key, kernel);
    worker.on("error", () => {
      if (kernels.get(key)?.worker === worker) kernels.delete(key);
    });
    worker.on("exit", () => {
      if (kernels.get(key)?.worker === worker) kernels.delete(key);
    });
  }
  const selected = kernel;
  const worker = selected.worker;
  const id = crypto.randomUUID();
  selected.busy = true;
  return await new Promise<NodeReplRunResult>((resolveRun, rejectRun) => {
    let settled = false;
    const cleanup = () => {
      input.signal.removeEventListener("abort", onAbort);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      selected.busy = false;
      selected.touched = Date.now();
    };
    const finish = (error?: unknown, result?: NodeReplRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) {
        kernels.delete(key);
        void worker.terminate();
        rejectRun(error);
      } else if (result) resolveRun(result);
      else rejectRun(new Error("node_repl worker returned no result"));
    };
    const onAbort = () => finish(input.signal.reason ?? new DOMException("aborted", "AbortError"));
    const onMessage = (message: { id?: string; result?: NodeReplRunResult }) => {
      if (message.id === id) finish(undefined, message.result);
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number) => finish(new Error(`node_repl worker exited (${code})`));
    input.signal.addEventListener("abort", onAbort, { once: true });
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    worker.postMessage({
      id,
      code: input.code,
      requestMeta: input.requestMeta,
      syncTimeoutMs: input.syncTimeoutMs,
      cuaBroker: input.cuaBroker,
    });
    if (input.signal.aborted) onAbort();
  });
}

function parseToolInput<T>(schema: z.ZodType<T>, input: unknown, toolName: string): T {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  invalidParams(`${toolName}: ${issue?.message ?? "invalid arguments"}`);
}

function invalidParams(message: string): never {
  throw Object.assign(new Error(message), { code: INVALID_PARAMS });
}

function buildRequestMeta(meta: Record<string, unknown> | undefined): NodeReplRequestMeta {
  const parsed = requestContextSchema.safeParse(meta?.["com.zcode/request-context"]);
  // 安全边界：顶层 MCP _meta 是第三方可扩展字段，不能成为 ZCode session 路由凭据。
  // 只有 host client 写入的命名空间会进入 Browser bridge；旧 client 的普通 JS 仍可执行。
  return parsed.success ? parsed.data : {};
}

function requestSessionKey(meta: NodeReplRequestMeta): string {
  const sessionId = meta.session_id;
  const identity =
    typeof meta.workspace_identity === "string" ? meta.workspace_identity.trim() : "";
  return typeof sessionId === "string" && sessionId.trim()
    ? JSON.stringify([
        identity || meta.workspace_path || meta.workspace_key || "",
        sessionId,
        meta.runtime_scope || "main",
      ])
    : UNTRUSTED_SESSION_KEY;
}

export { installNodeReplProcessGuards, installNodeReplShutdownTriggers };

export async function main(): Promise<void> {
  setNodeReplMcpProcessTitle();
  const runtimes = new Set<NodeReplMcpRuntime>();
  // 官方 plugin host 在 main() 返回后会清除短暂恢复的 Helper 凭据，而
  // serveStdio 的 server factory 要到 MCP initialize 时才执行。过去在 factory 内读取
  // process.env，必然得到空值，导致 node_repl 永久把 Computer Use 判为 unavailable。
  // 这里在 main() 生命周期内先捕获 runtime；Worker 只收到二次 bridge token，
  // 不会接触 Helper 的原始 socket/token。
  const computerUseRuntime = captureComputerUseRuntimeFromEnvironment();
  const handle = serveStdio(
    () => {
      const runtime = createNodeReplMcpRuntime({ cuaRuntime: computerUseRuntime });
      runtimes.add(runtime);
      return runtime.server;
    },
    { legacy: "reject" },
  );
  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    for (const runtime of runtimes) runtime.dispose();
    void handle
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  installNodeReplProcessGuards({
    onOutputClosed: shutdown,
    process,
    writeStderr: (text) => process.stderr.write(text),
  });
  installNodeReplShutdownTriggers({ process, shutdown, stdin: process.stdin });
}

if (!isMainThread && isWorkerCallData(workerData)) {
  const execute = createInProcessNodeReplExecutor();
  parentPort?.on("message", (cell: WorkerCallData & { id: string }) => {
    void execute({
      code: cell.code,
      requestMeta: cell.requestMeta,
      signal: new AbortController().signal,
      syncTimeoutMs: cell.syncTimeoutMs,
      cuaBroker: cell.cuaBroker,
    })
      .then((result) => parentPort?.postMessage({ id: cell.id, result }))
      .catch((error) =>
        parentPort?.postMessage({
          id: cell.id,
          result: {
            logs: "",
            error: {
              name: error instanceof Error ? error.name : "Error",
              message: error instanceof Error ? error.message : String(error),
            },
          } satisfies NodeReplRunResult,
        }),
      );
  });
}

export function captureComputerUseRuntimeFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ComputerUseRuntime | undefined {
  const socketPath = env.ZCODE_CUA_PERMISSION_BROKER_SOCKET?.trim();
  if (!socketPath) return undefined;
  return createComputerUseRuntime({
    brokerSocketPath: socketPath,
    brokerToken: env.ZCODE_CUA_BROKER_TOKEN,
    refreshMarkerPath: env.ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER?.trim(),
  });
}

function isWorkerCallData(value: unknown): value is WorkerCallData {
  if (!value || typeof value !== "object") return false;
  return (value as { kind?: unknown }).kind === WORKER_KIND;
}

if (isMainThread && (await isDirectMcpEntrypoint(import.meta.url, process.argv[1]))) {
  void main().catch((error) => {
    process.stderr.write(
      `node_repl MCP server failed: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
