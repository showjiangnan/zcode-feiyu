// Modified by ZCode Feiyu contributors (2026).
import { randomUUID } from "node:crypto";
import { ipcMain, type BrowserWindow, type UtilityProcess } from "electron";
import {
  HostMessageTypes,
  InternalChannels,
  databaseStartupControlSchema,
  type DatabaseStartupState,
} from "@zcode/shared";
import { reportDatabaseStartupState } from "./databaseStartupTelemetry.js";

let localStorageReady = false;
let quit: (() => void) | undefined;
export function configureDatabaseStartupQuit(handler: () => void): void {
  quit = handler;
}
const readyListeners = new Set<() => void>();
/** Main 只按 Host ready 调度既有 scheduler，不拥有迁移状态或账本。 */
export function onLocalDatabaseStartupReady(listener: () => void): void {
  if (localStorageReady) listener();
  else readyListeners.add(listener);
}

// 直接读取当前进程的 startup snapshot，不再用第二份 WeakSet 缓存 ready；
// fork/realtime 注册早于服务初始化，不能作为派发就绪证明。
const hostStartupSnapshots = new WeakMap<UtilityProcess, () => DatabaseStartupState | undefined>();
const hostReadyListeners = new Set<() => void>();
export function isHostDatabaseReady(child: UtilityProcess): boolean {
  return hostStartupSnapshots.get(child)?.()?.phase === "ready";
}
/** 每个 Host 进入 ready 时通知（含重建的 Host），用于唤醒等待 Host 的派发。 */
export function onHostDatabaseReady(listener: () => void): () => void {
  hostReadyListeners.add(listener);
  return () => hostReadyListeners.delete(listener);
}

const windowBindings = new WeakMap<BrowserWindow, () => void>();
const hostStartupIds = new WeakMap<UtilityProcess, string>();
export function getDatabaseStartupPortPayload(
  child: UtilityProcess,
): { databaseStartupId: string } | undefined {
  const databaseStartupId = hostStartupIds.get(child);
  return databaseStartupId ? { databaseStartupId } : undefined;
}

export function bindDatabaseStartupRelay(
  win: BrowserWindow,
  child: UtilityProcess,
  startupId = randomUUID(),
) {
  // 同窗口重建 Host 时，旧监听不能继续重放 ready 或接收用户控制命令。
  windowBindings.get(win)?.();
  hostStartupIds.set(child, startupId);
  let disposed = false;
  let latest: DatabaseStartupState | undefined;
  let exited = false;
  hostStartupSnapshots.set(child, () => (disposed || exited ? undefined : latest));
  const forward = (state: DatabaseStartupState) => {
    if (!disposed && !win.isDestroyed() && !win.webContents.isDestroyed())
      win.webContents.send(InternalChannels.DatabaseStartupState, state);
  };
  const applyState = (state: DatabaseStartupState) => {
    if (latest && state.startupId === latest.startupId && state.sequence <= latest.sequence) return;
    const wasReady = latest?.phase === "ready";
    latest = state;
    forward(state);
    try {
      reportDatabaseStartupState(state);
    } catch {
      /* 遥测故障不阻断启动。 */
    }
    if (state.phase === "ready" && !localStorageReady) {
      localStorageReady = true;
      for (const listener of readyListeners) listener();
      readyListeners.clear();
    }
    if (state.phase === "ready" && !exited && !wasReady) {
      for (const listener of hostReadyListeners) listener();
    }
  };
  const receive = (state: DatabaseStartupState) => {
    if (disposed || exited || state.startupId !== startupId) return;
    applyState(state);
  };
  const control = (event: Electron.IpcMainEvent, raw: unknown) => {
    if (disposed || event.sender !== win.webContents) return;
    const result = databaseStartupControlSchema.safeParse(raw);
    if (!result.success) return;
    if (result.data.action === "exit") {
      quit?.();
      return;
    }
    if (result.data.action === "snapshot" && latest) forward(latest);
    if (!exited)
      child.postMessage({ type: HostMessageTypes.DatabaseStartupControl, control: result.data });
  };
  const onExit = () => {
    exited = true;
    hostStartupIds.delete(child);
    if (!latest) {
      const now = Date.now();
      latest = {
        schemaVersion: 1,
        startupId,
        attemptId: randomUUID(),
        sequence: 0,
        startedAt: now,
        updatedAt: now,
        phase: "starting",
        disk: [],
      };
    }
    // 即使旧代曾 ready，退出后的 reload 也只能读到失败，不能用旧证明放行新端口。
    if (latest.phase !== "failed")
      applyState({
        ...latest,
        sequence: latest.sequence + 1,
        updatedAt: Date.now(),
        failedPhase: latest.phase,
        phase: "failed",
        errorCode: "transport_closed",
      });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    hostStartupSnapshots.delete(child);
    ipcMain.removeListener(InternalChannels.DatabaseStartupControl, control);
    win.removeListener("closed", dispose);
    child.removeListener("exit", onExit);
    hostStartupIds.delete(child);
    if (windowBindings.get(win) === dispose) windowBindings.delete(win);
  };
  windowBindings.set(win, dispose);
  ipcMain.on(InternalChannels.DatabaseStartupControl, control);
  win.once("closed", dispose);
  child.once("exit", onExit);
  return { receive, startupId };
}
