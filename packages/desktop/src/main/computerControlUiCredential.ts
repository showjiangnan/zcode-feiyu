// Modified by ZCode Feiyu contributors (2026).
import { randomBytes } from "node:crypto";
import type { BrowserWindow } from "electron";

// 每窗口 Host 代际的原生 UI 资格；不含任务事实，不通过远程 RPC 或 Agent 环境下发。
const credentials = new WeakMap<BrowserWindow, string>();
export function rotateComputerControlUiCredential(window: BrowserWindow): string {
  const token = randomBytes(32).toString("hex");
  credentials.set(window, token);
  return token;
}
export function readComputerControlUiCredential(window?: BrowserWindow | null): string | undefined {
  return window && !window.isDestroyed() ? credentials.get(window) : undefined;
}
