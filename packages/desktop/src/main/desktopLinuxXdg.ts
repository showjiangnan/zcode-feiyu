import { spawnSync } from "node:child_process";

// Linux XDG 桌面集成共享基础设施：deep link 注册（desktopLinuxDeepLinkRegistration）
// 与 AppImage 图标安装（desktopLinuxAppImageIcon）共用，独立成模块避免两者互相依赖形成环。

export const XDG_COMMAND_TIMEOUT_MS = 2_000;

export interface LinuxDeepLinkRegistrationLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface LinuxDesktopCommandResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
  stderr?: string;
}

export type LinuxDesktopCommandRunner = (
  command: string,
  args: string[],
) => LinuxDesktopCommandResult;

export function runXdgCommand(command: string, args: string[]): LinuxDesktopCommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: XDG_COMMAND_TIMEOUT_MS,
  });
  // encoding: "utf8" 时 stderr 已是 string，无需再兼容 Buffer 分支。
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stderr: result.stderr,
  };
}
