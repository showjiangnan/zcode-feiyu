// Modified by ZCode Feiyu contributors (2026).
import { promisify } from "node:util";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { CuaError, LIMITS, PROTOCOL } from "../domain/protocol.js";
import { validateControlPresentation } from "../../control-contract.js";

export class NativeProcess {
  constructor(executable, args = [], options = {}) {
    this.executable = executable;
    this.args = args;
    this.options = options;
    this.pending = new Map();
    this.cancelling = new Map();
    this.generation = randomUUID();
    this.disposed = false;
  }
  start() {
    if (this.disposed) throw new CuaError("disposed", "Native control service has closed");
    if (this.child) return;
    const {
      onEvent: _onEvent,
      cancellationGraceMs: _cancellationGraceMs,
      shutdownGraceMs: _shutdownGraceMs,
      ...spawnOptions
    } = this.options;
    const child = spawn(this.executable, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...spawnOptions,
    });
    this.child = child;
    child.stdin.on("error", (error) => this.fail(error));
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      // exit 早于 stdio close；旧进程迟到的事件不能暂停已启动的新代际。
      if (this.child !== child || this.disposed) return;
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > LIMITS.responseBytes) {
        this.fail(new CuaError("response_too_large", "Native response exceeds limit"));
        child.kill();
        return;
      }
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          const result = JSON.parse(line);
          if (result.protocol !== PROTOCOL || typeof result.id !== "string")
            throw new CuaError("version_mismatch", "Native response protocol mismatch");
          if (result.event) {
            this.options.onEvent?.(result.event);
            continue;
          }
          // cancel ACK 只证明 reader 收到了取消；原请求返回才证明串行 worker 已脱离阻塞。
          const cancellation = this.cancelling.get(result.id);
          if (cancellation) {
            clearTimeout(cancellation);
            this.cancelling.delete(result.id);
            continue;
          }
          const pending = this.pending.get(result.id);
          if (!pending) continue;
          this.pending.delete(result.id);
          pending.cleanup();
          if (result.ok) pending.resolve(result.result);
          else
            pending.reject(
              new CuaError(
                result.error?.code || "native_error",
                result.error?.message || "Native operation failed",
                result.error?.details,
              ),
            );
        } catch {
          this.fail(new CuaError("invalid_response", "Native response is invalid"));
          child.kill();
        }
      }
    });
    child.stderr.on("data", () => {}); // 原生诊断不包含用户画面，结构化错误由控制通道返回。
    child.on("error", (error) => this.fail(error));
    child.on("exit", () => {
      if (this.child === child) this.child = undefined;
      this.generation = randomUUID();
      this.clearCancellations();
      this.options.onEvent?.({ kind: "runtime-exited" });
      this.fail(
        new CuaError(
          "native_exited",
          "Native control service exited; previous references have expired",
        ),
      );
    });
  }
  clearCancellations() {
    for (const timer of this.cancelling.values()) clearTimeout(timer);
    this.cancelling.clear();
  }
  fail(error) {
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(error);
    }
    this.pending.clear();
  }
  setPresentation(value) {
    const next = validateControlPresentation(value);
    if (JSON.stringify(next) === JSON.stringify(this.presentation)) return;
    this.presentation = next;
    // UI 样式同步不应使空闲 Helper 启动；已有原生实例在下一条控制请求接收投影。
    if (this.child) void this.call("presentation").catch(() => undefined);
  }
  async call(method, params = {}, { signal, timeoutMs = LIMITS.operationMs } = {}) {
    if (signal?.aborted) throw signal.reason;
    if (params.approved && process.platform === "darwin") {
      const report = await this.preflight();
      params = {
        ...params,
        freshAccessibility: report.accessibility === "granted",
        freshScreenCapture: report.screen_recording === "granted",
      };
      signal?.throwIfAborted();
    }
    this.start();
    if (this.cancelling.size)
      throw new CuaError(
        "native_recovering",
        "Cancelled native work has not finished; retry after recovery",
      );
    if (this.pending.size >= LIMITS.inFlight)
      throw new CuaError("busy", "Native control service has too many operations in flight");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = (reason, submitted = true) => {
        if (!this.pending.delete(id)) return;
        cleanup();
        if (!(reason instanceof Error))
          reason = new CuaError("cancelled", "Computer operation cancelled");
        reason.details = {
          ...reason.details,
          outcome: submitted ? "partial-or-unknown" : "rejected",
        };
        if (!submitted) {
          reject(reason);
          return;
        }
        // 不透明重放未知动作。宽限内围栏拒绝新 admission，超时实例必须显式重启。
        this.cancelling.set(
          id,
          setTimeout(() => {
            this.options.onEvent?.({ kind: "runtime-unresponsive" });
            void this.close().catch(() => {
              this.options.onEvent?.({ kind: "runtime-close-unconfirmed" });
            });
          }, this.options.cancellationGraceMs ?? 500),
        );
        this.child?.stdin.write(
          `${JSON.stringify({ protocol: PROTOCOL, id: randomUUID(), method: "cancel", params: { requestId: id } })}\n`,
        );
        reject(reason);
      };
      const abort = () =>
        cancel(signal.reason || new CuaError("cancelled", "Computer operation cancelled"));
      const timer = setTimeout(
        () =>
          cancel(
            new CuaError(
              "deadline",
              "Native operation deadline exceeded; obtain a fresh observation",
            ),
          ),
        timeoutMs,
      );
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      const body = JSON.stringify({
        protocol: PROTOCOL,
        id,
        method,
        params: {
          ...params,
          presentation: this.presentation,
          nativeGeneration: this.generation,
          deadlineMs: timeoutMs,
        },
      });
      if (Buffer.byteLength(body) > LIMITS.requestBytes) {
        cancel(new CuaError("input_too_large", "Native request exceeds limit"), false);
        return;
      }
      this.child.stdin.write(`${body}\n`, (error) => {
        if (error) cancel(error);
      });
    });
  }
  async preflight() {
    if (this.preflightPending) return this.preflightPending;
    this.preflightPending = promisify(execFile)(this.executable, [...this.args, "--preflight"], {
      timeout: 5000,
      maxBuffer: 65536,
      windowsHide: true,
    })
      .then(({ stdout }) => JSON.parse(stdout))
      .finally(() => {
        this.preflightPending = undefined;
      });
    return this.preflightPending;
  }
  close() {
    if (this.disposed && !this.child) return Promise.resolve();
    if (this.closing) return this.closing;
    this.disposed = true;
    this.clearCancellations();
    const child = this.child;
    if (!child) return Promise.resolve();
    this.fail(new CuaError("disposed", "Native control service has closed"));
    this.closing = new Promise((resolve, reject) => {
      let exitDeadline;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        // 发出 kill 并非退出证据；替换必须等 exit，否则继续保持 disposed 围栏。
        exitDeadline = setTimeout(
          () =>
            reject(
              new CuaError(
                "native_close_unconfirmed",
                "Native process exit could not be confirmed",
              ),
            ),
          2000,
        );
      }, this.options.shutdownGraceMs ?? 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        clearTimeout(exitDeadline);
        resolve();
      });
      child.stdin.end();
    });
    return this.closing;
  }
}
