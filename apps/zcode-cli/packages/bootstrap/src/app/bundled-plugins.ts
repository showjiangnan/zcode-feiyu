// Modified by ZCode Feiyu.
import { OFFICIAL_PLUGIN_MARKETPLACE } from "./bundled-plugin-source.js";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeBundledOfficialMarketplacePartitionSync } from "@zcode/adapters";
import { type Logger } from "@zcode/contracts";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID } from "@zcode/shared";
import {
  createOfficialPluginCacheRetryBudget,
  isTransientOfficialPluginCacheFsError,
  type OfficialPluginCacheRetryBudget,
  removeOfficialPluginCacheDirectory,
} from "./official-plugin-cache-fs.js";
import { type OfficialPluginDefinition } from "./official-plugin-definitions.js";
import { writeOfficialPluginRuntimeManifest } from "./official-plugin-runtime.js";
import {
  isOfficialPluginSeedLockTimeoutError,
  withOfficialPluginSeedLock,
} from "./official-plugin-seed-lock.js";

import {
  type OfficialPluginSeedPluginSource,
  type OfficialPluginSeedSource,
  resolveSeedSource,
  readSeedFileBytes,
  modeForSeedFile,
  uniquePaths,
  hashBytes,
} from "./bundled-plugin-source.js";
import {
  SEED_MARKER_FILE,
  isSeedCurrent,
  findUsableOfficialPluginFallback,
  replaceSeedRoot,
  cleanupLegacySeedBackup,
  isNotFoundFsError,
  warnCacheDegraded,
  seedMarker,
  officialPluginCacheRoot,
} from "./bundled-plugin-cache.js";
export { candidateBaseDirs } from "./bundled-plugin-source.js";
export { findMissingOfficialPluginSeedPaths } from "./bundled-plugin-cache.js";

const SEED_LOCK_TOTAL_BUDGET_MS = 15_000;

function seedBundledOfficialPlugins(input: {
  logger?: Logger;
  storageRoot: string;
}): OfficialPluginDefinition[] {
  const source = resolveSeedSource();
  if (!source) return [];

  // Catalog/cache 是内置插件的不可变产品资产；Runtime 是否加载由 discovery 的抑制态决定，
  // 不能在 seed 阶段删除或过滤，否则卸载后详情页无法读取组件，也无法恢复。
  writeOfficialMarketplace(input.storageRoot, source);
  const retryBudget = createOfficialPluginCacheRetryBudget();
  // 等锁超时降级后循环会继续；若每个插件独立重置 15s 等待预算，成组遗留的
  // 锁会让启动同步冻结 N×15s。全部插件共享同一截止时间：无争用的锁仍瞬时获取（mkdir
  // 一次成功不查预算），预算耗尽后有争用的锁立即降级，seeding 总等待封顶 15s。
  const seedLockDeadlineAt = Date.now() + SEED_LOCK_TOTAL_BUDGET_MS;
  const failedSeeds: OfficialPluginDefinition[] = [];
  for (const plugin of source.plugins) {
    const pluginId = `${plugin.definition.name}@${OFFICIAL_PLUGIN_MARKETPLACE}`;
    const targetRoot = officialPluginCacheRoot(input.storageRoot, plugin.definition);
    // 入口旁的插件拷贝可能与新定义错配（升级中的桌面包、旧 checkout 未构建 dist）。
    // 缺 requiredSeedPaths 时 seed 源解析曾直接抛错，一个残缺插件把全部插件连同会话恢复
    // 一起炸成 resumeFailed。残缺只作用于单插件：拒绝写缓存，按既有降级协议告警并回退到可用旧缓存。
    if (plugin.missingSeedPaths.length > 0) {
      warnCacheDegraded(input.logger, {
        error: Object.assign(
          new Error(
            `Bundled official plugin ${plugin.definition.name} is missing required seed assets: ${plugin.missingSeedPaths.join(", ")}`,
          ),
          { code: "ZCODE_PLUGIN_SEED_INCOMPLETE" },
        ),
        missingSeedPaths: plugin.missingSeedPaths,
        operation: "seed_plugin",
        pluginId,
        targetRoot,
      });
      failedSeeds.push(plugin.definition);
      continue;
    }
    try {
      withOfficialPluginSeedLock(
        targetRoot,
        () => {
          // 桌面会并发预热多个 workspace Agent；复制插件资源时，
          // 多进程会互删 target 并在 Windows rename 时触发 EPERM。拿锁后必须二次检查，
          // 让等待者直接复用首个进程已经提交的完整缓存。
          if (isSeedCurrent(targetRoot, plugin)) {
            cleanupLegacySeedBackup(targetRoot, retryBudget);
            const manifestWritten = tryWriteOfficialPluginRuntimeManifest({
              pluginName: plugin.definition.name,
              retryBudget,
              rootPath: targetRoot,
            });
            if (manifestWritten) return;
          }

          const temporaryRoot = `${targetRoot}.tmp-${process.pid}-${Date.now()}`;
          removeOfficialPluginCacheDirectory(temporaryRoot, retryBudget);
          mkdirSync(temporaryRoot, { recursive: true });

          try {
            for (const file of plugin.files) {
              const bytes = readSeedFileBytes(source, plugin, file);
              if (hashBytes(bytes) !== file.sha256) {
                throw new Error(
                  `Bundled plugin asset hash mismatch: ${plugin.definition.name}/${file.path}`,
                );
              }
              const outputPath = join(temporaryRoot, ...file.path.split("/"));
              mkdirSync(dirname(outputPath), { recursive: true });
              writeFileSync(outputPath, bytes);
              chmodSync(outputPath, modeForSeedFile(file.path, file.mode));
            }

            writeFileSync(
              join(temporaryRoot, SEED_MARKER_FILE),
              JSON.stringify(seedMarker(source, plugin), null, 2),
            );
            replaceSeedRoot(temporaryRoot, targetRoot, plugin, retryBudget);
            writeOfficialPluginRuntimeManifest({
              pluginName: plugin.definition.name,
              retryBudget,
              rootPath: targetRoot,
            });
          } catch (error) {
            try {
              removeOfficialPluginCacheDirectory(temporaryRoot, retryBudget);
            } catch {
              // 临时目录清理失败不能覆盖真正的 seed 错误；目录名唯一，不会污染后续加载。
            }
            throw error;
          }
        },
        { timeoutMs: Math.max(0, seedLockDeadlineAt - Date.now()) },
      );
    } catch (error) {
      if (
        isTransientOfficialPluginCacheFsError(error) ||
        // seed lock 等待超时只说明同版本缓存锁被别的进程持有或遗留（Windows 上
        // 删不掉的遗留锁 + PID 复用会让接管长期不触发）。seeding 只是刷新缓存，超时必须
        // 走既有降级协议回退到可用缓存并告警，不能把会话恢复整体炸成 resumeFailed。
        isOfficialPluginSeedLockTimeoutError(error) ||
        // 多个 workspace app 会并发 seed 同一份官方插件缓存。当前进程
        // 写 runtime manifest 时，并发赢家可能已经原子替换整个 targetRoot，连同本进程
        // 的临时文件一起移走，rename 因此返回 ENOENT。只在新 target 已由 marker 证明
        // 完整时降级；目标缺失或仍旧时继续抛错，不能掩盖真实缓存损坏。
        (isNotFoundFsError(error) && isSeedCurrent(targetRoot, plugin))
      ) {
        warnCacheDegraded(input.logger, {
          error,
          operation: "seed_plugin",
          pluginId,
          targetRoot,
        });
        failedSeeds.push(plugin.definition);
        continue;
      }
      throw error;
    }
  }
  return failedSeeds;
}

function tryWriteOfficialPluginRuntimeManifest(input: {
  pluginName: string;
  retryBudget: OfficialPluginCacheRetryBudget;
  rootPath: string;
}): boolean {
  try {
    writeOfficialPluginRuntimeManifest(input);
    return true;
  } catch (error) {
    if (isTransientOfficialPluginCacheFsError(error)) throw error;
    return false;
  }
}

export function resolveOfficialPluginRoots(input: {
  env?: NodeJS.ProcessEnv;
  extraRoots?: string[];
  logger?: Logger;
  storageRoot: string;
  suppressedBuiltins?: ReadonlySet<string>;
}): string[] {
  const suppressedBuiltins = new Set(input.suppressedBuiltins ?? []);
  // 系统插件始终在本机清单中；开关仅控制能力准入，不再用历史抑制态隐藏入口。
  if (["darwin", "win32"].includes(process.platform))
    suppressedBuiltins.delete(ZCODE_CUA_OFFICIAL_PLUGIN_ID);
  else suppressedBuiltins.add(ZCODE_CUA_OFFICIAL_PLUGIN_ID);
  const failedSeeds = seedBundledOfficialPlugins({
    logger: input.logger,
    storageRoot: input.storageRoot,
  });

  const fallbackRoots = failedSeeds.flatMap((definition) => {
    // CUA 的 frame contract 随 wrapper 与 producer 原子升级。加载旧版本
    // cache 会把旧 block 布局接到新 consumer 上；当前 cache 不可用时宁可不注册 CUA。
    if (`${definition.name}@${OFFICIAL_PLUGIN_MARKETPLACE}` === ZCODE_CUA_OFFICIAL_PLUGIN_ID) {
      return [];
    }
    const fallbackRoot = findUsableOfficialPluginFallback(input.storageRoot, definition);
    return fallbackRoot ? [fallbackRoot] : [];
  });
  return uniquePaths([...(input.extraRoots ?? []), ...fallbackRoots]);
}

function writeOfficialMarketplace(storageRoot: string, source: OfficialPluginSeedSource): void {
  writeBundledOfficialMarketplacePartitionSync({
    manifest: {
      name: OFFICIAL_PLUGIN_MARKETPLACE,
      plugins: source.plugins.map((plugin) => {
        // 商店信息（listing）与描述随目录条目下发：键名与 CDN 目录 schema 一致，
        // 由 adapter 的同一套 parseEntryStoreListing 解析，UI 才能给内置插件渲染
        // 显示名/分类/作者/示例提示词。描述取自插件包内 plugin.json（单一事实源）。
        const description = readSeedPluginDescription(source, plugin);
        return {
          cachePath: officialPluginCacheRoot(storageRoot, plugin.definition),
          ...(description ? { description } : {}),
          name: plugin.definition.name,
          source: source.kind,
          version: plugin.definition.version,
          ...plugin.definition.listing,
        };
      }),
      version: 1,
    },
    storageRoot,
  });
}

/** 从 seed 文件集中读插件 plugin.json 的 description；读取/解析失败按 undefined 降级。 */
function readSeedPluginDescription(
  source: OfficialPluginSeedSource,
  plugin: OfficialPluginSeedPluginSource,
): string | undefined {
  const manifestFile = plugin.files.find((file) => file.path === ".zcode-plugin/plugin.json");
  if (!manifestFile) return undefined;
  try {
    const parsed = JSON.parse(readSeedFileBytes(source, plugin, manifestFile).toString("utf8")) as {
      description?: unknown;
    };
    return typeof parsed.description === "string" && parsed.description.trim().length > 0
      ? parsed.description
      : undefined;
  } catch {
    return undefined;
  }
}
