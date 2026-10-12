// Modified by ZCode Feiyu.
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

const assetDirectories = ["sdk", "protocol", "web"];
const excluded = new Set([
  "node_modules",
  "dist",
  "out",
  "test",
  "tests",
  "spec",
  "docs",
  "fixtures",
  ".turbo",
]);

async function filesUnder(root, directory, source = false) {
  const files = [];
  async function walk(path) {
    const info = await lstat(path).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink()) {
      if (source) return;
      throw new Error("RCS_ASSET_SYMLINK_DENIED");
    }
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) {
        if (
          source &&
          (excluded.has(entry) ||
            entry.startsWith(".env") ||
            /\.(?:test|spec)\.|\.tsbuildinfo$/u.test(entry))
        )
          continue;
        await walk(join(path, entry));
      }
    } else if (info.isFile()) files.push(relative(root, path).split(sep).join("/"));
  }
  await walk(join(root, directory));
  return files;
}

async function fingerprint(root, files) {
  const entries = [];
  for (const path of [...new Set(files)].sort())
    entries.push([
      path,
      createHash("sha256")
        .update(await readFile(join(root, path)))
        .digest("hex"),
    ]);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export async function sourceFingerprint(root) {
  const inputs = [
    "package.json",
    "pnpm-lock.yaml",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
    "config/provider",
    "scripts/build-rcs-assets.mjs",
    "scripts/rcs-asset-delivery.mjs",
    "scripts/rcs-build-provenance.mjs",
    "scripts/third-party-notices.mjs",
  ];
  for (const name of [
    "rpc",
    "shared",
    "client",
    "services",
    "ui",
    "web",
    "provider",
    "provider-node",
    "model-option-map",
    "zcode-cua",
  ])
    inputs.push(`packages/${name}`);
  const files = [];
  for (const input of inputs) files.push(...(await filesUnder(root, input, true)));
  return fingerprint(root, files);
}

export async function assetFingerprint(root) {
  const files = [];
  for (const directory of assetDirectories) files.push(...(await filesUnder(root, directory)));
  return fingerprint(
    root,
    files.filter((path) => path !== "web/build-info.json"),
  );
}

async function validateSource(root, destination) {
  const target = await realpath(destination);
  const source = await realpath(root);
  const inside = (parent, child) => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && !path.startsWith(`..${sep}`) && path !== "..");
  };
  if (
    (await lstat(destination)).isSymbolicLink() ||
    inside(source, target) ||
    inside(target, source)
  )
    throw new Error("RCS_EXPORT_DESTINATION_DENIED");
  for (const directory of assetDirectories) {
    const entry = await lstat(join(target, directory)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
      throw new Error("RCS_ASSET_DESTINATION_DENIED");
  }
  const text = await readFile(join(target, "pyproject.toml"), "utf8");
  const project = text.match(/^\[project\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/mu)?.[1];
  const version = project?.match(/^version\s*=\s*["']([^"']+)["']\s*$/mu)?.[1];
  if (!version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u.test(version))
    throw new Error("RCS_RELEASE_VERSION_INVALID");
  const build = JSON.parse(
    await readFile(join(source, "packages/web/dist/rcs-source.json"), "utf8"),
  );
  if (
    build.environment !== "production" ||
    build.sourceFingerprint !== (await sourceFingerprint(source))
  )
    throw new Error("RCS_WEB_BUILD_STALE");
  const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  if (build.version !== pkg.version) throw new Error("RCS_WEB_VERSION_MISMATCH");
  await readFile(join(source, "packages/web/dist/index.html"));
  return { target, version, build };
}

async function validateAssets(stage, release) {
  for (const path of [
    "sdk/index.js",
    "sdk/index.d.ts",
    "sdk/package.json",
    "protocol/services.json",
    "protocol/request.schema.json",
    "protocol/v4.schema.json",
    "web/index.html",
  ])
    await readFile(join(stage, path));
  const sdk = JSON.parse(await readFile(join(stage, "sdk/package.json"), "utf8"));
  const info = JSON.parse(await readFile(join(stage, "web/build-info.json"), "utf8"));
  const protocol = JSON.parse(await readFile(join(stage, "protocol/services.json"), "utf8"));
  if (
    sdk.version !== release.version ||
    info.rcsVersion !== release.version ||
    info.sdkVersion !== release.version ||
    info.sourceFingerprint !== release.build.sourceFingerprint
  )
    throw new Error("RCS_ASSET_VERSION_MISMATCH");
  for (const key of ["bridgeVersion", "rpcCodec", "agentWire"])
    if (info[key] !== protocol[key]) throw new Error("RCS_ASSET_PROTOCOL_MISMATCH");
  const files = [];
  for (const dir of assetDirectories) files.push(...(await filesUnder(stage, dir)));
  if (files.some((path) => path.endsWith(".map"))) throw new Error("RCS_SOURCE_MAP_DENIED");
  for (const path of files.filter((name) => /\.(?:js|mjs|cjs|css)$/u.test(name))) {
    const before = await readFile(join(stage, path), "utf8");
    const after = before
      .replace(/(?:^|\n)[\t ]*\/\/[#@][\t ]*sourceMappingURL=[^\r\n]*(?:\r?\n|$)/gu, "\n")
      .replace(/\/\*[#@][\t ]*sourceMappingURL=[^*]*\*\//gu, "");
    if (before !== after) await writeFile(join(stage, path), after);
  }
  const html = await readFile(join(stage, "web/index.html"), "utf8");
  for (const match of html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/gu))
    await readFile(join(stage, "web", match[1].slice(1)));
  const metadata = { ...info, artifactFingerprint: await assetFingerprint(stage) };
  await writeFile(join(stage, "web/build-info.json"), JSON.stringify(metadata, null, 2) + "\n");
  return metadata;
}

export async function deliverRcsAssets({ root, destination, generate, move = rename }) {
  const release = await validateSource(root, destination);
  const lockPath = join(release.target, ".rcs-assets-export.lock");
  const lock = await open(lockPath, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST") throw new Error("RCS_EXPORT_BUSY");
    throw error;
  });
  const lockInfo = await lock.stat();
  let temporary;
  let preserveRecovery = false;
  try {
    temporary = await mkdtemp(join(release.target, ".rcs-assets-stage-"));
    const stage = join(temporary, "next"),
      backup = join(temporary, "previous");
    await mkdir(stage);
    await mkdir(backup);
    await generate(stage, release.version, release.build);
    const metadata = await validateAssets(stage, release);
    if ((await sourceFingerprint(root)) !== release.build.sourceFingerprint)
      throw new Error("RCS_SOURCE_CHANGED_DURING_EXPORT");
    const moved = [];
    try {
      for (const directory of assetDirectories) {
        const record = { directory, backedUp: false, installed: false };
        moved.push(record);
        const target = join(release.target, directory);
        const present = await lstat(target).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (present) {
          await move(target, join(backup, directory));
          record.backedUp = true;
        }
        await move(join(stage, directory), target);
        record.installed = true;
      }
    } catch (failure) {
      // 三个目录必须来自同一生成；提交失败时完整回滚，不能留下新 SDK 与旧 Web。
      const errors = [];
      for (const record of moved.reverse()) {
        try {
          const target = join(release.target, record.directory);
          if (record.installed) await rm(target, { recursive: true, force: true });
          if (record.backedUp) await rename(join(backup, record.directory), target);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        preserveRecovery = true;
        throw new AggregateError([failure, ...errors], `RCS recovery retained at ${temporary}`);
      }
      throw failure;
    }
    return metadata;
  } finally {
    try {
      if (temporary && !preserveRecovery) await rm(temporary, { recursive: true, force: true });
    } finally {
      await lock.close();
      const current = await lstat(lockPath).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (current?.ino === lockInfo.ino && current?.dev === lockInfo.dev) await rm(lockPath);
    }
  }
}
