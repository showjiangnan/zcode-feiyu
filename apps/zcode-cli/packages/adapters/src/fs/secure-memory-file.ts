// Modified by ZCode Feiyu contributors (2026).
import { createRequire } from "node:module";
import { isAbsolute, relative } from "node:path";
import { Worker } from "node:worker_threads";
import { SECURE_MEMORY_WORKER } from "./secure-memory-worker.js";
import { SECURE_MEMORY_WINDOWS_WORKER } from "./secure-memory-windows-worker.js";

export interface SecureMemoryContent {
  content: string;
  size: number;
  mtimeMs: number;
  hash: string;
  bytes?: Uint8Array;
}
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type WorkerState = { worker: Worker; pending: Map<number, Pending>; failure?: Error };
let current: WorkerState | undefined;
let serial = 0;
const ADMISSION_OPEN = 0,
  ADMISSION_CANCELLED = 1;

function workerState(): WorkerState {
  if (current) return current;
  // 安装包的 eval Worker 没有模块目录；必须由调用方解析绝对 native 入口，不能依赖 Worker cwd。
  const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
  const worker = new Worker(
    process.platform === "win32" ? SECURE_MEMORY_WINDOWS_WORKER : SECURE_MEMORY_WORKER,
    {
      eval: true,
      workerData: { koffiPath: require.resolve("koffi") },
    },
  );
  const state: WorkerState = { worker, pending: new Map() };
  current = state;
  worker.on(
    "message",
    (message: {
      id: number;
      result?: unknown;
      error?: { message: string; code?: string; name?: string };
    }) => {
      const request = state.pending.get(message.id);
      state.pending.delete(message.id);
      if (message.error)
        request?.reject(
          Object.assign(new Error(message.error.message), {
            code: message.error.code,
            name: message.error.name ?? "Error",
          }),
        );
      else request?.resolve(message.result);
      if (!state.pending.size) worker.unref();
    },
  );
  const fail = (cause: Error) => {
    if (state.failure) return;
    const error = Object.assign(
      new Error("Memory worker exited; its pinned capabilities are no longer valid", { cause }),
      { code: "PROJECT_MEMORY_WORKER_EXITED" },
    );
    state.failure = error;
    for (const request of state.pending.values()) request.reject(error);
    state.pending.clear();
    worker.unref();
    // 旧 Worker 的迟到 error/exit 不能清空新代次；退出码 0 同样会丢失全部原生句柄。
    if (current === state) current = undefined;
  };
  worker.on("error", fail);
  worker.on("exit", (code) => fail(new Error(`Memory worker exited: ${code}`)));
  return state;
}

async function call<T>(state: WorkerState, command: string, args: unknown[]): Promise<T> {
  if (state.failure) throw state.failure;
  state.worker.ref();
  const id = ++serial;
  return new Promise<T>((resolve, reject) => {
    state.pending.set(id, { resolve: (value) => resolve(value as T), reject });
    try {
      state.worker.postMessage({ id, command, args });
    } catch (error) {
      state.pending.delete(id);
      if (!state.pending.size) state.worker.unref();
      reject(error);
    }
  });
}

export async function withSecureMemoryFile<T>(
  root: string,
  path: string,
  create: boolean,
  operation: (file: {
    read: (maxBytes?: number) => Promise<SecureMemoryContent>;
    list: () => Promise<string[]>;
    stat: () => Promise<{
      kind: "file" | "directory" | "other";
      sizeBytes: number;
      mtimeMs: number;
    }>;
    replace: (
      content: string,
      expectedHash?: string,
      absent?: boolean,
      signal?: AbortSignal,
    ) => Promise<SecureMemoryContent>;
    remove: (expectedHash: string, signal?: AbortSignal) => Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  if (!isAbsolute(root) || !isAbsolute(path) || root.includes("\0") || path.includes("\0")) {
    throw Object.assign(new Error("Memory paths must be absolute and contain no NUL"), {
      code: "EINVAL",
    });
  }
  const state = workerState();
  const id = await call<number>(state, "pin", [root, relative(root, path), create]);
  let active = true;
  const request = async <R>(command: string, ...args: unknown[]): Promise<R> => {
    if (!active) throw Object.assign(new Error("Memory capability is closed"), { code: "EBADF" });
    return call<R>(state, command, [id, ...args]);
  };
  const mutate = async <R>(command: string, args: unknown[], signal?: AbortSignal): Promise<R> => {
    if (!signal) return request<R>(command, ...args);
    signal.throwIfAborted();
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
      state = new Int32Array(gate);
    // Worker 同步 native 调用期间收不到取消消息；共享原子门让取消与最终提交只有一个胜者。
    const abort = () => {
      Atomics.compareExchange(state, 0, ADMISSION_OPEN, ADMISSION_CANCELLED);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await request<R>(command, ...args, gate);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
  let result: T;
  try {
    result = await operation({
      read: (maxBytes) => request("read", maxBytes),
      list: () => request("list"),
      stat: () => request("stat"),
      replace: (content, expectedHash, absent, signal) =>
        mutate("replace", [content, expectedHash, absent], signal),
      remove: (expectedHash, signal) => mutate("remove", [expectedHash], signal),
    });
  } catch (error) {
    active = false;
    try {
      await call(state, "close", [id]);
    } catch {} // 保留原始失败；旧 ID 不能转发到新代次。
    throw error;
  }
  active = false;
  await call(state, "close", [id]);
  return result;
}
