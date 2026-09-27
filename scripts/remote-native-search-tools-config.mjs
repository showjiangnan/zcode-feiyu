import { resolve } from "node:path";
import process from "node:process";
import {
  NATIVE_SEARCH_DEPENDENCIES_DIR,
  resolveNativeSearchBuildPlan,
  resolveNativeSearchPrebuiltPlan,
} from "./native-search-tools-config.mjs";

export const LEGACY_REMOTE_RIPGREP_VERSION = "v13.0.0-10";

export const LEGACY_REMOTE_RIPGREP_ARCHIVE_SHA256_BY_TARGET = Object.freeze({
  "darwin-arm64": "de44338ca53677968bdd7403ddc1cf9c735e708f7b63e3b34367f9411010a7db",
  "darwin-x64": "3b501c05ff9b1d24ae8897dd1c6b5bf842fd12a6f7114264407ac42bc222b25b",
  "linux-arm64": "705fc9bcd14baa18bd4dda8fe0651bff440fc0fb934fcdb8e745a85efd7b2afa",
  "linux-x64": "ef820a62c1d6fdc396646762ff0f0e47e127947073ed8b5aa4ceea8b61cb1659",
  "win32-arm64": "6c12d2c95073a4b981e5706981f42327b6359fc4cd7449ebd11f6769768dea97",
  "win32-x64": "7b35b95cf3d7f92d8fe087006899617b1b5a6dac4bbed5d4f6ace6f0934799dc",
});

export function resolveRemoteNativeSearchPrebuiltPlan({
  platform = process.platform,
  arch = process.arch,
  outputDir,
  dependenciesDir = NATIVE_SEARCH_DEPENDENCIES_DIR,
} = {}) {
  const buildPlan = resolveNativeSearchBuildPlan({ platform, arch, outputDir });
  if (buildPlan.platform === "linux") {
    return resolveNativeSearchPrebuiltPlan({ platform, arch, outputDir, dependenciesDir });
  }
  if (buildPlan.platform !== "darwin") {
    throw new Error(`unsupported remote native search target ${buildPlan.platformKey}`);
  }

  // macOS remote retains rg13; Desktop and SEA use the default rg14 plan.
  const release = LEGACY_REMOTE_RIPGREP_VERSION;
  const archiveTarget = `${buildPlan.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin.tar.gz`;
  const releaseFileName = `ripgrep-${release}-${archiveTarget}`;
  return {
    platform: buildPlan.platform,
    arch: buildPlan.arch,
    platformKey: buildPlan.platformKey,
    outputDir: buildPlan.outputDir,
    runtimeToolIds: ["ripgrep"],
    producerOutputIds: [],
    binaries: { ripgrep: buildPlan.rgPath },
    rgPath: buildPlan.rgPath,
    artifacts: [
      {
        toolId: "ripgrep",
        version: "13.0.0",
        release,
        releaseFileName,
        archiveExt: "tar.gz",
        archiveSha256: LEGACY_REMOTE_RIPGREP_ARCHIVE_SHA256_BY_TARGET[buildPlan.platformKey],
        binaryName: "rg",
        binaryPath: buildPlan.rgPath,
        archivePath: resolve(dependenciesDir, `ripgrep-${release}`, releaseFileName),
        source: "official",
      },
    ],
  };
}
