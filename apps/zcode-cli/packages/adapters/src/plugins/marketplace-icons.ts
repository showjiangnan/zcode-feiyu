// Modified by ZCode Feiyu.
import { join, resolve } from "node:path";
import { isRecord } from "./helpers.js";
import {
  PLUGIN_NAME_PATTERN,
  SOURCE_SHA256_PATTERN,
  PLUGIN_ICON_ASSETS_BASE_URL,
  CLAUDE_OFFICIAL_MARKETPLACE,
  PLUGIN_ICON_SOURCES_FILE,
  PLUGIN_ICON_SOURCES_URL,
  type PluginIconSourceRecord,
} from "./marketplace-types.js";
import { loadMarketplaceManifestSync } from "./marketplace-state.js";
import { writeMarketplaceManifest } from "./marketplace-activation.js";
import { readJsonFileSync, writeJsonFile } from "./marketplace-paths.js";
import { requestMarketplaceJson } from "./marketplace-json-request.js";

export const claudeIconMigrationAttempts = new Set<string>();

export function parsePluginIconSources(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const icon = typeof item.icon === "string" ? item.icon.trim() : "";
    const mimeType = typeof item.mimeType === "string" ? item.mimeType : undefined;
    const sha256 = typeof item.sha256 === "string" ? item.sha256 : undefined;
    if (!PLUGIN_NAME_PATTERN.test(name) || !isSafePluginIconPath(icon)) continue;
    if (mimeType !== undefined && mimeType !== "image/png") continue;
    if (sha256 !== undefined && !SOURCE_SHA256_PATTERN.test(sha256)) continue;
    result.set(name, new URL(icon, PLUGIN_ICON_ASSETS_BASE_URL).href);
  }
  return result;
}

export function applyClaudePluginIcons(
  manifest: Record<string, unknown>,
  iconByPluginName: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (!Array.isArray(manifest.plugins) || iconByPluginName.size === 0) return manifest;
  let changed = false;
  const plugins = manifest.plugins.map((plugin) => {
    if (!isRecord(plugin) || typeof plugin.name !== "string") return plugin;
    if (typeof plugin.icon === "string" && plugin.icon.trim().length > 0) return plugin;
    const icon = iconByPluginName.get(plugin.name);
    if (!icon) return plugin;
    changed = true;
    return { ...plugin, icon };
  });
  return changed ? { ...manifest, plugins } : manifest;
}

export async function enrichCachedClaudeMarketplaceIcons(
  storageRoot: string,
  withWriteLock: (write: () => Promise<void>) => Promise<void> = (write) => write(),
): Promise<void> {
  const attemptKey = resolve(storageRoot);
  if (claudeIconMigrationAttempts.has(attemptKey)) return;
  claudeIconMigrationAttempts.add(attemptKey);

  const manifest = loadMarketplaceManifestSync(storageRoot, CLAUDE_OFFICIAL_MARKETPLACE);
  if (!manifest) return;
  try {
    const iconSources = await loadClaudePluginIconSources(storageRoot);
    await withWriteLock(async () => {
      // 网络请求期间不持 plugin storage 锁；获得锁后必须重读，避免覆盖并发 marketplace 更新。
      const latest = loadMarketplaceManifestSync(storageRoot, CLAUDE_OFFICIAL_MARKETPLACE);
      if (!latest) return;
      const enriched = applyClaudePluginIcons(latest.raw, iconSources);
      if (enriched === latest.raw) return;
      // Bugfix：升级前已有 lastUpdated 的 catalog 不会触发 UI 自动刷新，导致新图标功能永远不可见。
      // 这里只回写展示增强字段，不重拉 marketplace，也不改变更新检测时间。
      await writeMarketplaceManifest(storageRoot, CLAUDE_OFFICIAL_MARKETPLACE, enriched);
    });
  } catch {
    // 存量图标迁移是 best-effort；失败不能让 plugins/overview 不可用，下次 Agent 启动可重试。
  }
}

export function isSafePluginIconPath(icon: string): boolean {
  if (!icon.endsWith(".png") || icon.startsWith("/") || icon.includes("\\")) return false;
  const segments = icon.split("/");
  return segments.length >= 2 && segments.every((segment) => PLUGIN_NAME_PATTERN.test(segment));
}

export async function loadClaudePluginIconSources(
  storageRoot: string,
  operationSignal?: AbortSignal,
): Promise<Map<string, string>> {
  const cachePath = join(storageRoot, PLUGIN_ICON_SOURCES_FILE);
  const cached = (): Map<string, string> => parsePluginIconSources(readJsonFileSync(cachePath));
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  operationSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 10_000);
  try {
    const response = await requestMarketplaceJson(
      PLUGIN_ICON_SOURCES_URL,
      undefined,
      controller.signal,
      10_000,
    );
    const value = response;
    const parsed = parsePluginIconSources(value);
    if (parsed.size === 0) return cached();
    // 缓存只保留产品需要的字段，不落盘素材源机器路径等 provenance 信息。
    const sanitized: PluginIconSourceRecord[] = [...parsed.entries()].map(([name, iconUrl]) => ({
      name,
      icon: new URL(iconUrl).pathname.slice(new URL(PLUGIN_ICON_ASSETS_BASE_URL).pathname.length),
      mimeType: "image/png",
    }));
    try {
      await writeJsonFile(cachePath, sanitized);
    } catch {
      // 图标缓存写入失败不影响本次 marketplace 主数据刷新。
    }
    return parsed;
  } catch {
    return cached();
  } finally {
    clearTimeout(timeout);
    operationSignal?.removeEventListener("abort", abort);
  }
}
