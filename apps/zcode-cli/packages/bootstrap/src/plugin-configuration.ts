// Modified by ZCode Feiyu.
import {
  removePluginEnabledFromFileConfig,
  removePluginFromFileConfig,
  removeSuppressedBuiltinInFileConfig,
  updatePluginOptionsInFileConfig,
} from "@zcode/adapters/config";
import {
  describeMarketplacePlugin,
  ensureDefaultPluginMarketplaces,
  ensureMarketplaceManifestAvailable,
  parseMarketplaceSourceInput,
  validateLocalPluginPath,
  validateMarketplacePlugin,
  validateMarketplaceSource,
  type DescribeMarketplacePluginResult,
  type MarketplaceSource,
} from "@zcode/adapters/plugins";
import type { PluginLoadOutcome } from "@zcode/contracts";

import { ZCODE_CUA_OFFICIAL_PLUGIN_ID, isZCodeCuaInternalFeatureEnabled } from "@zcode/shared";
import { resolveOfficialPluginRoots } from "./app/bundled-plugins.js";

import { withPluginStorageLock } from "./lib/plugin-storage-lock.js";

import { resolveZCodePlugins } from "./plugins.js";
import {
  type ValidateZCodePluginPathOptions,
  type RestoreBuiltinPluginOptions,
  type ConfigureZCodePluginOptions,
  type ResetZCodePluginConfigOptions,
  type ValidateZCodePluginOptions,
  type DescribeZCodePluginOptions,
} from "./plugin-operation-types.js";
import {
  resolvePluginContext,
  resolvePluginSelector,
  normalizePluginOptions,
  normalizePluginOptionKeys,
  resolvePluginConfigPath,
} from "./plugin-context.js";
import { toPluginDiagnostic } from "./plugin-presentation.js";
// 按职责拆分；保留原始规则、执行顺序与状态所有者。

/** `zcode plugins validate <path>`：只读校验本地插件目录或 marketplace 目录。 */
export async function validateZCodePluginPath(
  options: ValidateZCodePluginPathOptions,
): Promise<PluginLoadOutcome["diagnostics"]> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  return (
    await validateLocalPluginPath({
      path: options.path,
      signal: options.abortSignal,
      storageRoot: pluginStorageRoot,
    })
  ).map(toPluginDiagnostic);
}

export function applySparsePaths(
  source: MarketplaceSource,
  sparsePaths: string[] | undefined,
): MarketplaceSource {
  const paths = (sparsePaths ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
  if (paths.length === 0) return source;
  if (source.source !== "git" && source.source !== "github") {
    throw new Error("--sparse only applies to git or GitHub marketplace sources");
  }
  return { ...source, sparsePaths: paths };
}

/**
 * 恢复一个被抑制（uninstall）的内置（官方）插件的无锁核心。
 *
 * 调用方可能已经持有同一 storageRoot 的 storage lock（例如协议 install handler），
 * 因此核心不能再次获取 promise-chain lock；公开入口再负责提供锁保护。
 */
export async function restoreBuiltinPluginCore(
  options: RestoreBuiltinPluginOptions,
): Promise<void> {
  const zcodeCuaPluginId = ZCODE_CUA_OFFICIAL_PLUGIN_ID;
  if (
    options.pluginId === zcodeCuaPluginId &&
    !isZCodeCuaInternalFeatureEnabled(options.env ?? process.env)
  ) {
    // overview 虽然隐藏了恢复入口，但协议调用仍可绕过 UI 写用户配置。
    // 功能开关关闭时在写盘前失败，确保用户配置与插件缓存都保持零痕迹。
    throw new Error("computer-use built-in plugin requires ZCODE_CUA_PRODUCT_HELPER to be enabled");
  }
  const { configResult } = resolvePluginContext(options);
  await removeSuppressedBuiltinInFileConfig(configResult.sources.user.path, options.pluginId);
  // 重读磁盘上的最新 config（patch 后），确保抑制集合不再包含刚恢复的 id；
  // 不能复用 patch 前可能被传入的 configResult。
  const fresh = resolvePluginContext({ ...options, configResult: undefined });
  // 立即重新 seed，让插件即刻可用，无需等待下一次 resolve。
  resolveOfficialPluginRoots({
    storageRoot: fresh.pluginStorageRoot,
    suppressedBuiltins: new Set(fresh.configResult.config.plugins.suppressedBuiltins),
  });
}

export async function restoreBuiltinPlugin(options: RestoreBuiltinPluginOptions): Promise<void> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  await withPluginStorageLock(pluginStorageRoot, () => restoreBuiltinPluginCore(options));
}

export async function configureZCodePlugin(options: ConfigureZCodePluginOptions): Promise<void> {
  const normalizedOptions = normalizePluginOptions(options.options);
  const clearOptionKeys = normalizePluginOptionKeys(options.clearOptionKeys);
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  const outcome = resolveZCodePlugins({
    ...options,
    configResult,
    pluginStorageRoot,
    workingDirectory,
  });
  const plugin = resolvePluginSelector(options.pluginId, outcome.plugins);
  if (options.dryRun === true) return;
  await updatePluginOptionsInFileConfig(
    resolvePluginConfigPath(options, configResult, workingDirectory),
    plugin.id,
    normalizedOptions,
    clearOptionKeys,
  );
}

/** 删除指定 scope 的 Plugin 配置键，使 Workspace scope 回退到 User。 */
export async function resetZCodePluginConfig(
  options: ResetZCodePluginConfigOptions,
): Promise<{ path: string; pluginId: string }> {
  const { configResult, workingDirectory } = resolvePluginContext(options);
  const path = resolvePluginConfigPath(options, configResult, workingDirectory);
  if (options.scope === "workspace") {
    // “恢复继承”只删除 Workspace 的 enable override。options 是独立配置维度，
    // 不能因为用户恢复开关继承而把 Workspace options/secret 一并抹掉。
    await removePluginEnabledFromFileConfig(path, options.pluginId);
  } else {
    await removePluginFromFileConfig(path, options.pluginId);
  }
  return { path, pluginId: options.pluginId };
}

export async function validateZCodePlugin(
  options: ValidateZCodePluginOptions,
): Promise<PluginLoadOutcome["diagnostics"]> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  if (options.source) {
    try {
      const source = await parseMarketplaceSourceInput(options.source);
      return (
        await validateMarketplaceSource({
          source,
          storageRoot: pluginStorageRoot,
        })
      ).map(toPluginDiagnostic);
    } catch (error) {
      return [
        {
          code: "plugin_marketplace_invalid",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
        },
      ];
    }
  }
  if (options.marketplace && options.pluginName) {
    try {
      await ensureMarketplaceManifestAvailable({
        marketplace: options.marketplace,
        storageRoot: pluginStorageRoot,
      });
    } catch (error) {
      return [
        {
          code: "plugin_marketplace_invalid",
          message: error instanceof Error ? error.message : String(error),
          pluginId: `${options.pluginName}@${options.marketplace}`,
          severity: "error",
        },
      ];
    }
    return (
      await validateMarketplacePlugin({
        marketplace: options.marketplace,
        name: options.pluginName,
        storageRoot: pluginStorageRoot,
      })
    ).map(toPluginDiagnostic);
  }
  return [];
}

export async function describeZCodePlugin(
  options: DescribeZCodePluginOptions,
): Promise<DescribeMarketplacePluginResult> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  return describeMarketplacePlugin({
    marketplace: options.marketplace,
    name: options.pluginName,
    storageRoot: pluginStorageRoot,
  });
}
