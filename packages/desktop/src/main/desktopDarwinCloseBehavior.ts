// Modified by ZCode Feiyu contributors (2026).
import type { BackgroundContinuityStatus, BackgroundContinuityStopRecord } from "@zcode/shared";
import { randomUUID } from "node:crypto";

/** Main 原生停止结果的唯一 owner；Host runningTasks 和 readiness 均实时读取，不缓存任务状态。 */
export function createBackgroundContinuityController(deps: {
  platform: NodeJS.Platform;
  enabled(): boolean;
  hosts(): BackgroundContinuityStatus["hosts"];
  stopHost(windowId: number): Promise<void>;
}) {
  const stoppingWindows = new Set<number>();
  const history: BackgroundContinuityStopRecord[] = [];
  let pending: Promise<BackgroundContinuityStatus> | null = null;
  let error: string | null = null;
  const read = (): BackgroundContinuityStatus => {
    const hosts = deps.hosts();
    const supported = deps.platform === "darwin";
    const enabled = supported && deps.enabled();
    return {
      supported,
      enabled,
      hosts,
      error,
      state: pending
        ? "stopping"
        : error
          ? "failed"
          : !enabled
            ? "disabled"
            : hosts.some((host) => !host.visible && host.runningTasks > 0)
              ? "running"
              : "ready",
      stopHistory: history.map((record) => ({
        ...record,
        targets: record.targets.map((target) => ({ ...target })),
      })),
    };
  };
  const record = (
    reason: BackgroundContinuityStopRecord["reason"],
    startedAt: number,
    targets: BackgroundContinuityStopRecord["targets"],
  ): void => {
    const failures = targets.filter((target) => target.status === "failed");
    error = failures.length
      ? failures.map((target) => target.error ?? "Host stop failed").join("; ")
      : null;
    history.unshift({
      requestId: randomUUID(),
      reason,
      startedAt,
      finishedAt: Date.now(),
      targets,
      outcome:
        failures.length === 0
          ? "completed"
          : failures.length === targets.length
            ? "failed"
            : "partial_failure",
    });
    history.splice(20);
  };
  return {
    read,
    isStoppingWindow: (windowId: number) => stoppingWindows.has(windowId),
    recordAppQuit: (startedAt: number, targets: BackgroundContinuityStopRecord["targets"]) => {
      if (deps.platform === "darwin") record("app_quit", startedAt, targets);
    },
    stop(
      reason: BackgroundContinuityStopRecord["reason"] = "user_requested",
      excludeWindowId?: number,
    ): Promise<BackgroundContinuityStatus> {
      if (deps.platform !== "darwin") return Promise.resolve(read());
      if (pending) return pending;
      const startedAt = Date.now();
      // 手机撤销时即使 show 还未投影为 visible，也必须显式保护持有 profile 提交的 Host。
      const targets = deps
        .hosts()
        .filter((host) => !host.visible && host.windowId !== excludeWindowId);
      for (const target of targets) stoppingWindows.add(target.windowId);
      error = null;
      pending = Promise.all(
        targets.map(async (target): Promise<BackgroundContinuityStopRecord["targets"][number]> => {
          try {
            await deps.stopHost(target.windowId);
            return { windowId: target.windowId, status: "stopped" };
          } catch (cause) {
            return {
              windowId: target.windowId,
              status: "failed",
              error: cause instanceof Error ? cause.message : String(cause),
            };
          }
        }),
      )
        .then((results) => record(reason, startedAt, results))
        .finally(() => {
          stoppingWindows.clear();
          pending = null;
        })
        .then(read);
      return pending;
    },
  };
}

interface DarwinCloseAwareWindow {
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  hide(): void;
}

export function canDispatchToBackgroundWindow(
  platform: NodeJS.Platform,
  visible: boolean,
  continueAfterCloseOnMac: boolean,
): boolean {
  // macOS 关窗许可不适用于 Windows 托盘和 Linux 窗口生命周期。
  return platform !== "darwin" || visible || continueAfterCloseOnMac;
}

export function handleDarwinWindowCloseRequest(options: {
  win: DarwinCloseAwareWindow;
  forceQuit: boolean;
  continueAfterClose?: boolean;
  label: string;
  logger: { info: (...args: unknown[]) => void };
}): boolean {
  if (options.forceQuit) {
    return false;
  }

  if (options.win.isFullScreen()) {
    // macOS 原生全屏会占用独立 Space，之前这里仍然沿用“点红点=隐藏窗口”。
    // 全屏态下直接 hide() 会把窗口藏进全屏 Space，用户看到的就是黑屏，但窗口其实没真正关闭。
    // 这里改成先退出全屏，让“点关闭”在全屏场景下退回普通窗口，避免留下黑屏 Space。
    options.win.setFullScreen(false);
    options.logger.info(
      `[createWindow] fullscreen close converted to leave-full-screen (${options.label})`,
    );
    return true;
  }

  if (options.continueAfterClose === false) {
    return false;
  }

  options.win.hide();
  options.logger.info(`[createWindow] window hidden instead of closed (${options.label})`);
  return true;
}
