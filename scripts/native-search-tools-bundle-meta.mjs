import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const bundleMetaFileName = ".bundle-meta.json";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function expectedBundleMeta(artifact, platformKey, binarySha256) {
  return {
    ...(artifact.archiveSha256 ? { archiveSha256: artifact.archiveSha256 } : {}),
    binaryName: artifact.binaryName,
    platform: platformKey,
    provider: "native-search-tool",
    release: artifact.release,
    sha256: binarySha256,
    source: artifact.source,
    toolId: artifact.toolId,
    version: artifact.version,
  };
}

export function resolveNativeSearchBundleMetaPath(binaryPath) {
  return join(dirname(binaryPath), bundleMetaFileName);
}

export function isNativeSearchBundleCurrent(artifact, platformKey) {
  if (!existsSync(artifact.binaryPath)) return false;

  try {
    const actual = JSON.parse(
      readFileSync(resolveNativeSearchBundleMetaPath(artifact.binaryPath), "utf8"),
    );
    const expected = expectedBundleMeta(artifact, platformKey, sha256(artifact.binaryPath));
    return Object.entries(expected).every(([key, value]) => actual?.[key] === value);
  } catch {
    return false;
  }
}

export function writeNativeSearchBundleMeta(artifact, platformKey) {
  const metadata = expectedBundleMeta(artifact, platformKey, sha256(artifact.binaryPath));
  writeFileSync(
    resolveNativeSearchBundleMetaPath(artifact.binaryPath),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}

export function writeNativeSearchProducerBundleMeta(plan) {
  for (const artifact of plan.artifacts.filter(({ source }) => source === "producer")) {
    writeNativeSearchBundleMeta(artifact, plan.platformKey);
  }
}
