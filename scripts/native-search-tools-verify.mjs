import { readFileSync } from "node:fs";
import { basename } from "node:path";
import process from "node:process";
import {
  LINUX_NATIVE_SEARCH_GLIBC_BASELINE,
  MACOS_NATIVE_SEARCH_DEPLOYMENT_TARGET,
  NATIVE_SEARCH_BFS_CONFIGURE_ARGS,
  NATIVE_SEARCH_OFFICIAL_RIPGREP_ASSETS,
  NATIVE_SEARCH_TOOL_VERSIONS,
  getExpectedUgrepFeatureContract,
  getNativeSearchRuntimeToolIdsForPlatform,
  normalizeNativeSearchArch,
  normalizeNativeSearchPlatform,
} from "./native-search-tools-config.mjs";
import { runCapture } from "./native-search-tools-process.mjs";
import { verifyWindowsPeBinary } from "./native-search-tools-windows-pe.mjs";

const MACHO_MAGIC_64 = 0xfeedfacf;
const MACHO_EXECUTE_FILE_TYPE = 2;
const MACHO_CPU_TYPES = Object.freeze({ arm64: 0x0100000c, x64: 0x01000007 });
const ELF_MACHINE_TYPES = Object.freeze({ arm64: 0xb7, x64: 0x3e });

function fail(message) {
  throw new Error(message);
}

function verifyMachOTarget(binaryPath, arch) {
  const buffer = readFileSync(binaryPath);
  if (
    buffer.length < 16 ||
    buffer.readUInt32LE(0) !== MACHO_MAGIC_64 ||
    buffer.readUInt32LE(12) !== MACHO_EXECUTE_FILE_TYPE
  ) {
    fail(`${basename(binaryPath)} is not a 64-bit Mach-O executable`);
  }

  const cpuType = buffer.readUInt32LE(4);
  const expectedCpuType = MACHO_CPU_TYPES[arch];
  if (cpuType !== expectedCpuType) {
    fail(
      `${basename(binaryPath)} has Mach-O CPU type 0x${cpuType.toString(16)}; expected 0x${expectedCpuType.toString(16)} for ${arch}`,
    );
  }
}

function verifyElfTarget(binaryPath, arch) {
  const buffer = readFileSync(binaryPath);
  const isElf =
    buffer.length >= 20 &&
    buffer[0] === 0x7f &&
    buffer.toString("ascii", 1, 4) === "ELF" &&
    buffer[4] === 2 &&
    buffer[5] === 1;
  const fileType = isElf ? buffer.readUInt16LE(16) : 0;
  if (!isElf || (fileType !== 2 && fileType !== 3)) {
    fail(`${basename(binaryPath)} is not a 64-bit little-endian ELF executable`);
  }

  const machine = buffer.readUInt16LE(18);
  const expectedMachine = ELF_MACHINE_TYPES[arch];
  if (machine !== expectedMachine) {
    fail(
      `${basename(binaryPath)} has ELF machine 0x${machine.toString(16)}; expected 0x${expectedMachine.toString(16)} for ${arch}`,
    );
  }
}

export function verifyNativeSearchBinaryTarget(binaryPath, { platform, arch }) {
  const normalizedPlatform = normalizeNativeSearchPlatform(platform);
  const normalizedArch = normalizeNativeSearchArch(arch);
  switch (normalizedPlatform) {
    case "darwin":
      verifyMachOTarget(binaryPath, normalizedArch);
      return;
    case "linux":
      verifyElfTarget(binaryPath, normalizedArch);
      return;
    case "win32":
      verifyWindowsPeBinary(binaryPath, normalizedArch);
      return;
  }
}

function verifyBfsContract(bfsPath) {
  const bfsVersion = runCapture(bfsPath, ["--version"]);
  const expectedConfigureFlags = `CONFFLAGS := ${NATIVE_SEARCH_BFS_CONFIGURE_ARGS.join(" ")}`;
  if (
    !bfsVersion.startsWith(`bfs ${NATIVE_SEARCH_TOOL_VERSIONS.bfs}\n`) ||
    !bfsVersion.includes(expectedConfigureFlags)
  ) {
    fail(`unexpected bfs version output:\n${bfsVersion}`);
  }
  const regexTypes = runCapture(bfsPath, ["-regextype", "help"]);
  if (!regexTypes.includes("findutils-default")) {
    fail("bfs does not support -regextype findutils-default");
  }
}

function verifyUgrepContract(ugrepPath, platform) {
  const ugrepVersion = runCapture(ugrepPath, ["--version"]);
  const expectedFeatures = getExpectedUgrepFeatureContract(platform);
  if (
    !ugrepVersion.startsWith(`ugrep ${NATIVE_SEARCH_TOOL_VERSIONS.ugrep} `) ||
    !ugrepVersion.includes(expectedFeatures)
  ) {
    fail(`unexpected ugrep feature output:\n${ugrepVersion}`);
  }
}

function verifyRipgrepContract(rgPath, { arch, platform }) {
  const version = runCapture(rgPath, ["--version"]);
  const platformKey = `${platform}-${arch}`;
  const ripgrepAsset = NATIVE_SEARCH_OFFICIAL_RIPGREP_ASSETS[platformKey];
  if (!ripgrepAsset) {
    fail(`no verified ripgrep asset contract for ${platformKey}`);
  }
  const expectedRevision = ripgrepAsset.revision;
  const expectedVersionLine = expectedRevision
    ? `ripgrep ${NATIVE_SEARCH_TOOL_VERSIONS.ripgrep} (rev ${expectedRevision})`
    : `ripgrep ${NATIVE_SEARCH_TOOL_VERSIONS.ripgrep}`;
  if (
    version.split("\n", 1)[0] !== expectedVersionLine ||
    !version.includes("features:+pcre2") ||
    !version.includes("PCRE2 10.43 is available")
  ) {
    fail(`unexpected ripgrep feature output:\n${version}`);
  }
}

function compareDottedVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const partCount = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < partCount; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function getRequiredGlibcVersions(versionInfo) {
  const versions = new Set(
    [...String(versionInfo).matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/gu)].map((match) => match[1]),
  );
  return [...versions].sort(compareDottedVersions);
}

export function verifyLinuxGlibcBaseline(
  versionInfo,
  binaryName,
  baseline = LINUX_NATIVE_SEARCH_GLIBC_BASELINE,
) {
  const versions = getRequiredGlibcVersions(versionInfo);
  if (versions.length === 0) {
    fail(`${binaryName} is missing GLIBC symbol versions`);
  }

  const unsupportedVersion = versions.find(
    (version) => compareDottedVersions(version, baseline) > 0,
  );
  if (unsupportedVersion) {
    fail(
      `${binaryName} requires GLIBC_${unsupportedVersion}; maximum supported version is GLIBC_${baseline}`,
    );
  }
}

export function verifyMacosDeploymentTarget(
  buildVersion,
  binaryName,
  { allowLowerDeploymentTarget = false } = {},
) {
  // Microsoft x64 归档使用旧式 LC_VERSION_MIN_MACOSX，且更低的 target 不应被拒绝。
  const deploymentTargets = [
    ...[...buildVersion.matchAll(/^\s*minos\s+(\S+)\s*$/gmu)].map((match) => match[1]),
    ...[
      ...buildVersion.matchAll(
        /^\s*cmd\s+LC_VERSION_MIN_MACOSX\s*\n\s*cmdsize\s+\d+\s*\n\s*version\s+(\S+)\s*$/gmu,
      ),
    ].map((match) => match[1]),
  ];
  const targetComparison =
    deploymentTargets.length === 1
      ? compareDottedVersions(deploymentTargets[0], MACOS_NATIVE_SEARCH_DEPLOYMENT_TARGET)
      : undefined;
  if (
    targetComparison === undefined ||
    (allowLowerDeploymentTarget ? targetComparison > 0 : targetComparison !== 0)
  ) {
    const targetContract = allowLowerDeploymentTarget
      ? `maximum supported target is ${MACOS_NATIVE_SEARCH_DEPLOYMENT_TARGET}`
      : `expected target is ${MACOS_NATIVE_SEARCH_DEPLOYMENT_TARGET}`;
    fail(
      `${binaryName} has unsupported macOS deployment target: ${deploymentTargets.join(", ") || "missing"}; ${targetContract}`,
    );
  }
}

function verifyMacosBinary(
  binaryPath,
  { arch, allowedDependencies, allowLowerDeploymentTarget = false },
) {
  const fileOutput = runCapture("file", [binaryPath]);
  const expectedArchitecture = arch === "arm64" ? "arm64" : "x86_64";
  if (
    !fileOutput.includes("Mach-O 64-bit executable") ||
    !fileOutput.includes(expectedArchitecture)
  ) {
    fail(`unexpected ${basename(binaryPath)} architecture:\n${fileOutput}`);
  }

  const dependencies = runCapture("otool", ["-L", binaryPath])
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter(Boolean);
  const unexpectedDependencies = dependencies.filter(
    (dependency) => !allowedDependencies.includes(dependency),
  );
  if (unexpectedDependencies.length > 0) {
    fail(
      `${basename(binaryPath)} has non-system runtime dependencies: ${unexpectedDependencies.join(", ")}`,
    );
  }

  const buildVersion = runCapture("vtool", ["-show-build", binaryPath]);
  verifyMacosDeploymentTarget(buildVersion, basename(binaryPath), {
    allowLowerDeploymentTarget,
  });
}

function verifyLinuxBinary(binaryPath, { arch, allowedDependencies, glibcBaseline }) {
  const fileOutput = runCapture("file", [binaryPath]);
  const expectedArchitecture = arch === "arm64" ? "ARM aarch64" : "x86-64";
  if (!fileOutput.includes("ELF 64-bit") || !fileOutput.includes(expectedArchitecture)) {
    fail(`unexpected ${basename(binaryPath)} architecture:\n${fileOutput}`);
  }

  const dynamicSection = runCapture("readelf", ["-d", binaryPath]);
  const dependencies = [
    ...dynamicSection.matchAll(/\(NEEDED\).*Shared library: \[([^\]]+)\]/gu),
  ].map((match) => match[1]);
  const unexpectedDependencies = dependencies.filter(
    (dependency) => !allowedDependencies.includes(dependency),
  );
  if (unexpectedDependencies.length > 0) {
    fail(
      `${basename(binaryPath)} has unexpected runtime dependencies: ${unexpectedDependencies.join(", ")}`,
    );
  }

  if (glibcBaseline) {
    const versionInfo = runCapture("readelf", ["--version-info", binaryPath]);
    verifyLinuxGlibcBaseline(versionInfo, basename(binaryPath), glibcBaseline);
  }
}

export function getAllowedLinuxNativeSearchDependencies(toolId, arch) {
  const dynamicLoader = arch === "arm64" ? "ld-linux-aarch64.so.1" : "ld-linux-x86-64.so.2";
  const commonDependencies = [
    dynamicLoader,
    "libc.so.6",
    "libdl.so.2",
    "libm.so.6",
    "libpthread.so.0",
    "librt.so.1",
  ];

  switch (toolId) {
    case "bfs":
    case "ugrep":
      return commonDependencies;
    case "ripgrep":
      // 两种 Linux rg 都固定为 Microsoft musl 静态包，因此不应携带动态依赖。
      return [];
    default:
      fail(`unsupported Linux native search tool ${toolId}`);
  }
}

function verifyNativeSearchToolSet({
  bfsPath,
  rgPath,
  ugrepPath,
  platform,
  arch,
  toolIds,
  hostArch = process.arch,
  hostPlatform = process.platform,
}) {
  const normalizedPlatform = normalizeNativeSearchPlatform(platform);
  const normalizedArch = normalizeNativeSearchArch(arch);
  const includes = (toolId) => toolIds.includes(toolId);

  switch (normalizedPlatform) {
    case "darwin":
      if (includes("bfs")) {
        if (!bfsPath) fail("macOS native search tools are missing bfs");
        verifyBfsContract(bfsPath);
        verifyMacosBinary(bfsPath, {
          arch: normalizedArch,
          allowedDependencies: ["/usr/lib/libSystem.B.dylib"],
        });
      }
      if (includes("ugrep")) {
        if (!ugrepPath) fail("macOS native search tools are missing ugrep");
        verifyUgrepContract(ugrepPath, normalizedPlatform);
        verifyMacosBinary(ugrepPath, {
          arch: normalizedArch,
          allowedDependencies: ["/usr/lib/libSystem.B.dylib", "/usr/lib/libc++.1.dylib"],
        });
      }
      if (includes("ripgrep")) {
        if (!rgPath) fail("macOS native search tools are missing ripgrep");
        verifyRipgrepContract(rgPath, { arch: normalizedArch, platform: normalizedPlatform });
        verifyMacosBinary(rgPath, {
          arch: normalizedArch,
          allowedDependencies: ["/usr/lib/libSystem.B.dylib", "/usr/lib/libiconv.2.dylib"],
          allowLowerDeploymentTarget: true,
        });
      }
      return;
    case "linux": {
      if (includes("bfs")) {
        if (!bfsPath) fail("Linux native search tools are missing bfs");
        verifyLinuxBinary(bfsPath, {
          arch: normalizedArch,
          allowedDependencies: getAllowedLinuxNativeSearchDependencies("bfs", normalizedArch),
          glibcBaseline: LINUX_NATIVE_SEARCH_GLIBC_BASELINE,
        });
        verifyBfsContract(bfsPath);
      }
      if (includes("ugrep")) {
        if (!ugrepPath) fail("Linux native search tools are missing ugrep");
        verifyLinuxBinary(ugrepPath, {
          arch: normalizedArch,
          allowedDependencies: getAllowedLinuxNativeSearchDependencies("ugrep", normalizedArch),
          glibcBaseline: LINUX_NATIVE_SEARCH_GLIBC_BASELINE,
        });
        verifyUgrepContract(ugrepPath, normalizedPlatform);
      }
      if (includes("ripgrep")) {
        if (!rgPath) fail("Linux native search tools are missing ripgrep");
        verifyRipgrepContract(rgPath, { arch: normalizedArch, platform: normalizedPlatform });
        verifyLinuxBinary(rgPath, {
          arch: normalizedArch,
          allowedDependencies: getAllowedLinuxNativeSearchDependencies("ripgrep", normalizedArch),
        });
      }
      return;
    }
    case "win32": {
      if (includes("ugrep")) {
        if (!ugrepPath) fail("Windows native search tools are missing ugrep");
        verifyWindowsPeBinary(ugrepPath, normalizedArch);
      }
      if (includes("ripgrep")) {
        if (!rgPath) fail("Windows native search tools are missing ripgrep");
        verifyWindowsPeBinary(rgPath, normalizedArch);
      }

      // host 与 PE 目标架构相同不代表当前系统能执行 Windows 二进制。
      if (
        normalizeNativeSearchPlatform(hostPlatform) === "win32" &&
        normalizeNativeSearchArch(hostArch) === normalizedArch
      ) {
        if (includes("ugrep")) verifyUgrepContract(ugrepPath, normalizedPlatform);
        if (includes("ripgrep")) {
          verifyRipgrepContract(rgPath, {
            arch: normalizedArch,
            platform: normalizedPlatform,
          });
        }
      }
      return;
    }
    default:
      fail(`native search verification does not support platform ${normalizedPlatform}`);
  }
}

export function verifyBuiltNativeSearchProducerOutputs(options) {
  return verifyNativeSearchToolSet({
    ...options,
    toolIds: options.producerOutputIds,
  });
}

export function verifyBuiltNativeSearchTools(options) {
  return verifyNativeSearchToolSet({
    ...options,
    toolIds: getNativeSearchRuntimeToolIdsForPlatform(options.platform),
  });
}
