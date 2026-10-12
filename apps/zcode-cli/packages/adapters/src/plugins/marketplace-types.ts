// Modified by ZCode Feiyu.
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginDiagnostic, PluginStoreListing } from "@zcode/contracts";
import { type PluginComponentGroup } from "./plugin-components.js";
import { type AtomicDirectoryActivation } from "./atomic-directory.js";

export const execFileAsync = promisify(execFile);

export const KNOWN_MARKETPLACES_FILE = "known_marketplaces.json";

export const INSTALLED_PLUGINS_FILE = "installed_plugins.json";

export const MARKETPLACE_FILE = "marketplace.json";

export const CLAUDE_OFFICIAL_MARKETPLACE = "claude-plugins-official";

export const PLUGIN_ICON_SOURCES_FILE = "icon-sources.json";

export const PLUGIN_ICON_ASSETS_BASE_URL = "https://cdn-zcode.z.ai/zcode/official-plugin/assets/";

export const PLUGIN_ICON_SOURCES_URL = `${PLUGIN_ICON_ASSETS_BASE_URL}${PLUGIN_ICON_SOURCES_FILE}`;

export const MARKETPLACE_JSON_MAX_BYTES = 10 * 1024 * 1024;

export const MARKETPLACE_JSON_MAX_REDIRECTS = 5;

export const MARKETPLACE_JSON_TIMEOUT_MS = 180_000;

export const CLAUDE_MARKETPLACE_FILE = join(".claude-plugin", "marketplace.json");

export const ZCODE_MANIFEST_PATH = join(".zcode-plugin", "plugin.json");

export const CLAUDE_MANIFEST_PATH = join(".claude-plugin", "plugin.json");

export const CODEX_MANIFEST_PATH = join(".codex-plugin", "plugin.json");

export const DEFAULT_VERSION = "0.0.0";

export const GIT_CLONE_MAX_ATTEMPTS = 3;

export const GIT_COMMAND_TIMEOUT_MS = 90_000;

export const GIT_CLONE_RETRY_DELAY_MS = 1_000;

export const CLAUDE_MARKETPLACE_REFRESH_TIMEOUT_MS = 30_000;

export const MARKETPLACE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export const SOURCE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const UNSUPPORTED_MANIFEST_FIELDS = [
  "channels",
  "lspServers",
  "outputStyles",
  "settings",
] as const;

export type MarketplaceSource =
  | { source: "url"; headers?: Record<string, string>; url: string }
  | { path?: string; ref?: string; repo: string; source: "github"; sparsePaths?: string[] }
  | { path?: string; ref?: string; source: "git"; sparsePaths?: string[]; url: string }
  | { package: string; source: "npm" }
  | { source: "file"; path: string }
  | { source: "directory"; path: string }
  | { hostPattern: string; source: "hostPattern" }
  | { pathPattern: string; source: "pathPattern" }
  | { source: "settings"; marketplace: PluginMarketplaceManifest };

export interface PluginMarketplaceEntry {
  name: string;
  category?: string;
  description?: string;
  version?: string;
  source?: unknown;
  // 内置 official 插件 seed 时写入的缓存目录绝对路径（source 为 "filesystem"/"sea"）。
  // describe/解析时据此直接定位已落盘的插件根目录，无需把 source 当路径解析。
  cachePath?: string;
  dependencies?: string[];
  strict?: boolean;
  tags?: string[];
  // 商店信息（displayName/icon/hero/示例提示词/链接等展示元数据），从条目 raw 解析；
  // 全部可选，见 contracts PluginStoreListing。
  listing?: PluginStoreListing;
  raw: Record<string, unknown>;
}

export interface PluginMarketplaceManifest {
  name: string;
  description?: string;
  plugins: PluginMarketplaceEntry[];
  allowCrossMarketplaceDependenciesOn?: string[];
  pluginRoot?: string;
  // 商店「公开」分段 Featured 区的策展名单（插件 name，按序）；由目录 JSON 顶层 featured 字段远程控制。
  featured?: string[];
  raw: Record<string, unknown>;
}

export interface KnownMarketplaceRecord {
  id: string;
  source: MarketplaceSource;
  name: string;
  description?: string;
  addedAt: string;
  lastUpdated?: string;
  lastRefreshFailure?: MarketplaceRefreshFailure;
  pluginCount: number;
  /** 内部崩溃恢复代际；协议/UI 投影不暴露。 */
  cacheTransactionId?: string;
}

export interface MarketplaceRefreshFailure {
  code: PluginDiagnostic["code"];
  failedAt: string;
  message: string;
}

export interface InstalledPluginRecord {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  installPath: string;
  installedAt: string;
  updatedAt?: string;
  scope: "user" | "workspace";
  dependencies?: string[];
  source?: unknown;
  /** 内部崩溃恢复代际；协议/UI 投影不暴露。 */
  cacheTransactionId?: string;
}

export interface PluginIconSourceRecord {
  name: string;
  icon: string;
  mimeType?: string;
  sha256?: string;
}

export interface InstalledPluginsState {
  version: 1;
  plugins: InstalledPluginRecord[];
}

export interface MarketplaceInstallResult {
  closure: string[];
  installed: InstalledPluginRecord[];
}

export interface PluginValidationDiagnostic {
  code: PluginDiagnostic["code"];
  message: string;
  path?: string;
  pluginId?: string;
  severity: PluginDiagnostic["severity"];
}

export interface DescribeMarketplacePluginResult {
  components: PluginComponentGroup[];
  diagnostics: PluginValidationDiagnostic[];
  // 插件包内 plugin.json 的展示性回退字段（作者/主页/版本）；商店信息缺失时详情页信息区用它兜底。
  metadata?: PluginManifestDisplayMetadata;
}

export interface PluginManifestDisplayMetadata {
  author?: string;
  authorUrl?: string;
  homepage?: string;
  version?: string;
}

export interface MarketplaceOperationSignalScope {
  cleanup: () => void;
  signal?: AbortSignal;
  timedOut: boolean;
  timeoutError: Error;
}

export interface KnownMarketplaceActivation {
  finalize: () => void;
  rollback: () => Promise<void>;
}

export interface LoadMarketplaceResult {
  cleanup?: () => Promise<void>;
  manifest: PluginMarketplaceManifest;
  sourceRoot?: string;
}

export interface ResolvedPluginSourceRoot {
  cleanup?: () => Promise<void>;
  path: string;
}

export interface CachedMarketplacePluginResult {
  activation?: AtomicDirectoryActivation;
  record: InstalledPluginRecord;
}
