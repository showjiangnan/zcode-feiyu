// Modified by ZCode Feiyu.
import { basename, dirname, join } from "node:path";
import { isRecord } from "./helpers.js";
import { recoverAtomicTargetSync } from "./atomic-directory.js";
import {
  type KnownMarketplaceRecord,
  KNOWN_MARKETPLACES_FILE,
  type PluginMarketplaceManifest,
} from "./marketplace-types.js";
import {
  readJsonFileSync,
  isKnownMarketplaceRecord,
  getMarketplaceManifestPath,
} from "./marketplace-paths.js";
import { parseMarketplaceManifest } from "./marketplace-manifest.js";

export function loadKnownMarketplacesSync(storageRoot: string): KnownMarketplaceRecord[] {
  const parsed = readJsonFileSync(join(storageRoot, KNOWN_MARKETPLACES_FILE));
  if (!isRecord(parsed)) return [];
  const value = parsed.marketplaces;
  if (Array.isArray(value)) return value.filter(isKnownMarketplaceRecord);
  if (isRecord(value)) return Object.values(value).filter(isKnownMarketplaceRecord);
  return [];
}

export function loadMarketplaceManifestSync(
  storageRoot: string,
  marketplace: string,
): PluginMarketplaceManifest | null {
  const manifestPath = getMarketplaceManifestPath(storageRoot, marketplace);
  // 崩溃残留先恢复；若 writer 仍活跃，则在权威 known state 落盘前读 backup，
  // 落盘后读新 target，避免 overview 看见跨代 manifest/summary。
  const readableDirectory = recoverAtomicTargetSync(dirname(manifestPath));
  const parsed = readJsonFileSync(join(readableDirectory, basename(manifestPath)));
  return parseMarketplaceManifest(parsed);
}
