// Modified by ZCode Feiyu.
import { readFile, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, uptime } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { WorkspaceHookTrustRecord } from "@zcode/contracts";
import { type WorkspaceHookTrustStorePathOptions } from "./workspace-hook-trust-types.js";

export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

export const DEFAULT_STALE_LOCK_MS = 30_000;

export const LOCK_RETRY_MS = 10;

export const DEFAULT_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;

export const SECURITY_DIRECTORY = "security";

export const TRUST_STORE_FILE = "workspace-hook-trust-v1.json";

export // 进程启动时间的比较容差：ps/proc 的秒级精度 + 调度延迟，2s 足以覆盖且不放过复用。
const LOCK_START_TIME_TOLERANCE_MS = 2_000;

export const PROC_CLOCK_TICKS_PER_SECOND = 100;

export const execFileAsync = promisify(execFile);

export async function defaultWriteLockOwnerMetadata(
  handle: FileHandle,
  content: string,
): Promise<void> {
  await handle.writeFile(content, "utf8");
}

export /** 本进程启动时间的墙钟毫秒（惰性缓存：进程生命周期内不变）。 */
let ownStartTimeMs: number | undefined;

export function currentProcessStartTimeMs(): number {
  if (ownStartTimeMs === undefined) {
    ownStartTimeMs = Math.round(Date.now() - uptime() * 1_000);
  }
  return ownStartTimeMs;
}

export /**
 * 查询指定 pid 的当前进程实例启动时间（墙钟毫秒）；无法确定时返回 null。
 * 用于 stale 回收时区分「原 owner 实例仍存活」与「pid 已被复用给无关进程」
 * （裸 pid 只标识进程表槽位，不具备跨时间唯一性）。
 * - linux: /proc/<pid>/stat 字段 22（boot 后 ticks）
 * - darwin: ps -o lstart=
 * - win32: powershell Get-Process StartTime（成本较高，但只在超龄回收路径触发）
 * - 失败/不支持 → null，调用方保守视为原 owner 存活（不回收）。
 */
async function probeProcessStartTimeDefault(pid: number): Promise<number | null> {
  if (pid === process.pid) return currentProcessStartTimeMs();
  try {
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) return null;
      // ')' 之后 token[0] 是 state（字段 3）；starttime 是字段 22 → token[19]。
      const tokens = stat.slice(close + 2).split(" ");
      const ticks = Number(tokens[19]);
      if (!Number.isFinite(ticks)) return null;
      const bootMs = Date.now() - uptime() * 1_000;
      return Math.round(bootMs + (ticks * 1_000) / PROC_CLOCK_TICKS_PER_SECOND);
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
      const parsed = Date.parse(stdout.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `[DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`,
      ]);
      const parsed = Number(stdout.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveWorkspaceHookTrustStorePath(
  options: WorkspaceHookTrustStorePathOptions = {},
): Promise<string> {
  const home = resolve(options.homeDir ?? homedir());
  const userConfigPath = resolve(
    options.userConfigPath ?? join(home, ".zcode", "cli", "config.json"),
  );
  const config = await readUserConfig(userConfigPath);
  const storage = isRecord(config.storage) ? config.storage : {};
  const configured = typeof storage.dir === "string" ? storage.dir.trim() : "";
  const storageRoot = configured ? resolveTrustedUserPath(configured, home) : join(home, ".zcode");
  return join(storageRoot, SECURITY_DIRECTORY, TRUST_STORE_FILE);
}

export async function renameWithRetry(
  renameFile: typeof rename,
  tempPath: string,
  filePath: string,
  retryDelaysMs: readonly number[],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(tempPath, filePath);
      return;
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined || !isRetryableRenameError(error)) throw error;
      // Windows 杀软/索引器可能短暂占用目标文件，单次 rename 会让已完成
      // fsync 的 Trust mutation 误报失败。仅对已知短暂占用错误做有界异步重试。
      await sleep(delayMs);
    }
  }
}

export function isRetryableRenameError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

export async function readUserConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return {};
    throw new Error(`Unable to read trusted user config for Workspace Hook Trust store: ${path}`, {
      cause: error,
    });
  }
}

export function resolveTrustedUserPath(path: string, home: string): string {
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  // 安全原因：user config 中的相对 storage.dir 绑定用户目录，不能随 workspace cwd 漂移。
  return resolve(home, path);
}

export function trustKey(record: {
  workspaceIdentity: string;
  hookDeclarationDigest: string;
}): string {
  return `${record.workspaceIdentity}\u0000${record.hookDeclarationDigest}`;
}

export function recordTimestamp(record: WorkspaceHookTrustRecord): number {
  return Date.parse(record.lastUsedAt ?? record.grantedAt);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
