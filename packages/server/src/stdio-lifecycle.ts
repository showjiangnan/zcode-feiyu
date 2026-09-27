import type { Readable } from "node:stream";

const TERMINATION_SIGNALS = ["SIGHUP", "SIGTERM", "SIGINT"] as const;
const DEFAULT_RPC_STOP_TIMEOUT_MS = 1_000;
const DEFAULT_SERVICE_DISPOSE_TIMEOUT_MS = 3_500;

type StdioShutdownPhase = "rpc-stop" | "service-dispose";

interface StdioProcessSignalSource {
  on(signal: (typeof TERMINATION_SIGNALS)[number], listener: () => void): unknown;
}

interface StdioProcessLifecycleOptions {
  stdin: Readable;
  signalSource: StdioProcessSignalSource;
  log: (...args: unknown[]) => void;
  stopRpc: () => Promise<void>;
  dispose: () => Promise<void>;
  exit: (code: number) => never | void;
  shutdownTimeoutMs?: number;
  rpcStopTimeoutMs?: number;
  serviceDisposeTimeoutMs?: number;
}

export function registerStdioProcessLifecycle(options: StdioProcessLifecycleOptions): void {
  const { stdin, signalSource, log, stopRpc, dispose, exit } = options;
  const rpcStopTimeoutMs = Math.max(
    options.rpcStopTimeoutMs ?? options.shutdownTimeoutMs ?? DEFAULT_RPC_STOP_TIMEOUT_MS,
    0,
  );
  const serviceDisposeTimeoutMs = Math.max(
    options.serviceDisposeTimeoutMs ??
      options.shutdownTimeoutMs ??
      DEFAULT_SERVICE_DISPOSE_TIMEOUT_MS,
    0,
  );
  let shutdownStarted = false;
  let requestedExitCode = 0;

  const requestShutdown = (exitCode: number): void => {
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;

    void (async () => {
      const runPhase = async (
        phase: StdioShutdownPhase,
        operation: () => Promise<void>,
        failureMessage: string,
        timeoutMs: number,
      ): Promise<boolean> => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const operationResult = operation().then(
          () => ({ kind: "completed" as const }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        );
        const timedOut = new Promise<{ kind: "timed-out" }>((resolve) => {
          // timer 不能 unref，否则外部 Promise 永久 pending 时它无法独立保证收口。
          timeout = setTimeout(() => resolve({ kind: "timed-out" }), timeoutMs);
        });
        const result = await Promise.race([operationResult, timedOut]);
        if (timeout) {
          clearTimeout(timeout);
        }
        if (result.kind === "timed-out") {
          log("stdio shutdown timed out", { phase, timeoutMs });
          return false;
        }
        if (result.kind === "failed") {
          log(failureMessage, result.error);
          return false;
        }
        return true;
      };

      // 整个 cleanup 不能只设一个 race；stopRpc 一旦超时就直接 exit，
      // service dispose 永远没有机会关闭 Agent 子进程。两个外部异步边界必须各自有界并独立推进。
      if (
        !(await runPhase("rpc-stop", stopRpc, "stdio shutdown RPC stop failed", rpcStopTimeoutMs))
      ) {
        requestedExitCode = 1;
      }
      if (
        !(await runPhase(
          "service-dispose",
          dispose,
          "stdio shutdown cleanup failed",
          serviceDisposeTimeoutMs,
        ))
      ) {
        requestedExitCode = 1;
      }
      log("stdio shutdown completed", { exitCode: requestedExitCode });
      exit(requestedExitCode);
    })();
  };

  // 远程项目静置时可能长时间没有 client->server RPC 输入，但窗口仍然打开。
  // 不能再按空闲时间主动退出；只在 stdio 明确关闭或报错时结束远端 server，
  // 让远程连接生命周期跟随用户关闭项目/应用或底层 SSH 断连。
  stdin.on("end", () => {
    log("stdin closed, shutting down");
    requestShutdown(0);
  });
  stdin.on("error", (error) => {
    log("stdin error, shutting down", error);
    requestShutdown(1);
  });
  for (const signal of TERMINATION_SIGNALS) {
    signalSource.on(signal, () => {
      // SSH 断连在不同 sshd/shell 上可能表现为 stdin EOF，也可能先向前台进程发送信号。
      // 两类入口必须进入同一个幂等清理链路，否则 detached Agent 会绕过父进程退出而成为孤儿。
      log("termination signal received, shutting down", signal);
      requestShutdown(1);
    });
  }
}
