// Modified by ZCode Feiyu.
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { appendPluginSourceCleanupError, cleanupPluginSourceBestEffort } from "./helpers.js";
import { type MarketplaceSource, type LoadMarketplaceResult } from "./marketplace-types.js";
import { throwIfPluginOperationAborted } from "./marketplace-signals.js";
import {
  normalizeMarketplaceManifest,
  parseRequiredMarketplaceManifest,
} from "./marketplace-manifest.js";
import {
  findMarketplaceManifestPath,
  UnsupportedMarketplaceSourceError,
} from "./marketplace-paths.js";
import { stageMarketplaceDirectoryPlugins } from "./marketplace-activation.js";
import { requestMarketplaceJson } from "./marketplace-json-request.js";
import { resolveRepositoryMarketplaceSource } from "./marketplace-source.js";

export async function loadMarketplaceFromSource(
  source: MarketplaceSource,
  storageRoot: string,
  options: { persist: boolean; signal?: AbortSignal },
): Promise<LoadMarketplaceResult> {
  throwIfPluginOperationAborted(options.signal);
  switch (source.source) {
    case "settings":
      return { manifest: normalizeMarketplaceManifest(source.marketplace) };
    case "file": {
      const parsed = JSON.parse(await readFile(source.path, "utf8")) as unknown;
      return {
        manifest: parseRequiredMarketplaceManifest(parsed),
        sourceRoot: dirname(source.path),
      };
    }
    case "directory": {
      const file = findMarketplaceManifestPath(source.path);
      if (!file) throw new Error(`Marketplace manifest not found in directory: ${source.path}`);
      const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
      const manifest = parseRequiredMarketplaceManifest(parsed);
      if (options.persist) {
        const activation = await stageMarketplaceDirectoryPlugins(
          source.path,
          storageRoot,
          manifest.name,
          manifest.raw,
          options.signal,
        );
        await activation.finalize();
      }
      return { manifest, sourceRoot: source.path };
    }
    case "url": {
      const parsed = await requestMarketplaceJson(source.url, source.headers, options.signal);
      return { manifest: parseRequiredMarketplaceManifest(parsed) };
    }
    case "github": {
      const resolved = await resolveRepositoryMarketplaceSource(
        `https://github.com/${source.repo}.git`,
        source.ref,
        source.sparsePaths,
        options.signal,
      );
      const cleanup = resolved.cleanup;
      try {
        const file = findMarketplaceManifestPath(resolved.path, source.path);
        if (!file) throw new Error(`Marketplace manifest not found in GitHub repo: ${source.repo}`);
        const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
        const manifest = parseRequiredMarketplaceManifest(parsed);
        if (options.persist) {
          const activation = await stageMarketplaceDirectoryPlugins(
            resolved.path,
            storageRoot,
            manifest.name,
            manifest.raw,
            options.signal,
          );
          await activation.finalize();
        }
        return { cleanup, manifest, sourceRoot: resolved.path };
      } catch (error) {
        const cleanupError = await cleanupPluginSourceBestEffort(cleanup);
        throw appendPluginSourceCleanupError(error, cleanupError);
      }
    }
    case "git": {
      const resolved = await resolveRepositoryMarketplaceSource(
        source.url,
        source.ref,
        source.sparsePaths,
        options.signal,
      );
      const cleanup = resolved.cleanup;
      try {
        const file = findMarketplaceManifestPath(resolved.path, source.path);
        if (!file) throw new Error(`Marketplace manifest not found in git repo: ${source.url}`);
        const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
        const manifest = parseRequiredMarketplaceManifest(parsed);
        if (options.persist) {
          const activation = await stageMarketplaceDirectoryPlugins(
            resolved.path,
            storageRoot,
            manifest.name,
            manifest.raw,
            options.signal,
          );
          await activation.finalize();
        }
        return { cleanup, manifest, sourceRoot: resolved.path };
      } catch (error) {
        const cleanupError = await cleanupPluginSourceBestEffort(cleanup);
        throw appendPluginSourceCleanupError(error, cleanupError);
      }
    }
    case "npm":
      throw new UnsupportedMarketplaceSourceError("npm");
    case "hostPattern":
      throw new UnsupportedMarketplaceSourceError("hostPattern");
    case "pathPattern":
      throw new UnsupportedMarketplaceSourceError("pathPattern");
  }
}
