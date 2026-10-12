// Modified by ZCode Feiyu.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeZCodeRuntimeEnv } from "@zcode/shared";
import {
  appendPluginSourceCleanupError,
  cleanupPluginSourceBestEffort,
  isRecord,
} from "./helpers.js";
import { applyNetworkEgressEnv } from "../network/subprocess-env.js";
import { createGitUnavailableError, isCommandUnavailableError } from "./source-errors.js";
import {
  GIT_CLONE_MAX_ATTEMPTS,
  GIT_CLONE_RETRY_DELAY_MS,
  execFileAsync,
  GIT_COMMAND_TIMEOUT_MS,
} from "./marketplace-types.js";
import { throwIfPluginOperationAborted, delay } from "./marketplace-signals.js";

export function buildMarketplaceGitEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = sanitizeZCodeRuntimeEnv(sourceEnv);
  // marketplace 安装会启动 Git 子进程，不能只依赖父进程继承的 shell 代理。
  // 这里统一从 ZCode 显式网络环境恢复 HTTP(S)/NO_PROXY/CA，避免安装按钮卡到协议超时。
  return applyNetworkEgressEnv(env, { sourceEnv });
}

export async function clonePluginSource(
  url: string,
  ref: string | undefined,
  sha?: string,
  signal?: AbortSignal,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-src-"));
  const args = ["clone"];
  if (!sha) args.push("--depth", "1");
  if (ref) args.push("--branch", ref);
  args.push(url, dir);
  try {
    await execGitCloneWithRetry(args, dir, signal);
    if (sha) await execGitCommand(["-C", dir, "checkout", sha], signal);
    return dir;
  } catch (error) {
    const cleanupError = await cleanupPluginSourceBestEffort(async () => {
      await rm(dir, { force: true, recursive: true });
    });
    throw appendPluginSourceCleanupError(error, cleanupError);
  }
}

export function normalizeGitUrl(value: string): string {
  if (/^[^/]+\/[^/]+$/u.test(value) && !value.includes(":")) {
    return `https://github.com/${value}.git`;
  }
  return value;
}

export async function cloneMarketplaceSource(
  url: string,
  ref: string | undefined,
  sparsePaths: string[] | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-marketplace-src-"));
  const args = ["clone", "--depth", "1"];
  if (ref) args.push("--branch", ref);
  if (sparsePaths?.length) args.push("--filter=blob:none", "--sparse");
  args.push(url, dir);
  try {
    await execGitCloneWithRetry(args, dir, signal);
    if (sparsePaths?.length) {
      await execGitCommand(["-C", dir, "sparse-checkout", "set", ...sparsePaths], signal);
    }
    return dir;
  } catch (error) {
    await rm(dir, { force: true, recursive: true });
    throw error;
  }
}

export async function execGitCloneWithRetry(
  args: string[],
  targetDir: string,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= GIT_CLONE_MAX_ATTEMPTS; attempt += 1) {
    try {
      throwIfPluginOperationAborted(signal);
      if (attempt > 1) {
        await rm(targetDir, { force: true, recursive: true });
        await mkdir(targetDir, { recursive: true });
      }
      await execGitCommand(args, signal);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= GIT_CLONE_MAX_ATTEMPTS || !isRetryableGitCloneError(error)) {
        throw error;
      }
      // GitHub 偶发 RPC/recv timeout 会让官方 marketplace add 失败。
      // 仅对明确的网络型 clone 错误做短重试，避免掩盖权限、路径或仓库不存在等确定性错误。
      await delay(GIT_CLONE_RETRY_DELAY_MS * attempt, signal);
    }
  }
  throw lastError;
}

export async function execGitCommand(args: string[], signal?: AbortSignal): Promise<void> {
  throwIfPluginOperationAborted(signal);
  try {
    // 显式二进制覆盖既支持非标准 Git 安装位置，也让跨进程 E2E 能把 Git 指向不存在的
    // 绝对路径，真实证明 Archive 主链路不依赖开发机上偶然存在的 Git。
    const gitBinary = process.env.ZCODE_GIT_BINARY?.trim() || "git";
    await execFileAsync(gitBinary, args, {
      env: buildMarketplaceGitEnv(),
      killSignal: "SIGTERM",
      maxBuffer: 1024 * 1024 * 10,
      signal,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    if (isCommandUnavailableError(error)) {
      const source = args.find(
        (arg) => arg.includes("://") || arg.startsWith("git@") || arg.startsWith("git+"),
      );
      throw createGitUnavailableError(source ?? args.at(-1) ?? "Git operation");
    }
    throw error;
  }
  throwIfPluginOperationAborted(signal);
}

export function isRetryableGitCloneError(error: unknown): boolean {
  const output = getErrorOutput(error);
  return /RPC failed|Operation timed out|Recv failure|expected flush|early EOF|remote end hung up|HTTP\/2 stream|Connection reset|ETIMEDOUT|ECONNRESET|network timeout/iu.test(
    output,
  );
}

export function getErrorOutput(error: unknown): string {
  if (!isRecord(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  const chunks = [
    error instanceof Error ? error.message : "",
    typeof error.stdout === "string" ? error.stdout : "",
    typeof error.stderr === "string" ? error.stderr : "",
  ];
  return chunks.filter(Boolean).join("\n");
}
