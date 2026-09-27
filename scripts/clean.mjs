#!/usr/bin/env node

import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packagesDir = join(repoRoot, "packages");
const removableNames = new Set(["node_modules", "dist"]);

function collectPackageDirs() {
  if (!existsSync(packagesDir)) {
    return [];
  }

  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name));
}

function assertSafeTarget(targetPath, ownerDir) {
  if (!removableNames.has(basename(targetPath)) || dirname(targetPath) !== ownerDir) {
    throw new Error(`Refuse to remove unexpected path: ${targetPath}`);
  }
}

function removeTarget(targetPath, ownerDir) {
  assertSafeTarget(targetPath, ownerDir);

  if (!existsSync(targetPath)) {
    return false;
  }

  rmSync(targetPath, { force: true, recursive: true });
  console.log(`removed ${targetPath}`);
  return true;
}

const ownerDirs = [repoRoot, ...collectPackageDirs()];
let removedCount = 0;

for (const ownerDir of ownerDirs) {
  for (const name of removableNames) {
    if (removeTarget(join(ownerDir, name), ownerDir)) {
      removedCount += 1;
    }
  }
}

console.log(`clean removed ${removedCount} director${removedCount === 1 ? "y" : "ies"}`);
