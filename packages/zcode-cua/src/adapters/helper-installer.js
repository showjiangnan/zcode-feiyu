// Modified by ZCode Feiyu contributors (2026).
import { readFile, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, relative, isAbsolute, dirname } from "node:path";
import { release } from "node:os";
import { createHash } from "node:crypto";
import { CuaError } from "../domain/protocol.js";
const exec = promisify(execFile);
export const verifierDependencies = {
  async readExecutableArchs(path) {
    return (await exec("/usr/bin/lipo", ["-archs", path])).stdout
      .trim()
      .split(/\s+/)
      .map((value) => (value === "x86_64" ? "x64" : value));
  },
  async verifyCodeSignature(path) {
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", path]);
  },
  async verifyTeamIdentifier(path, expected) {
    if (!expected) return;
    const report = await exec("/usr/bin/codesign", ["-dv", "--verbose=4", path]);
    const actual = report.stderr.match(/TeamIdentifier=([^\n]+)/)?.[1];
    if (actual !== expected)
      throw new CuaError(
        "invalid_signature",
        "Native runtime team identifier does not match this distribution",
      );
  },
};
export async function helperIdentity(appPath) {
  const app = await realpath(appPath);
  const executablePath =
    process.platform === "win32"
      ? join(app, "zcode-computer-control.exe")
      : join(app, "Contents", "MacOS", "zcode-computer-control");
  return {
    appPath: app,
    executablePath,
    bundleId: "dev.zcode.cua-helper",
    displayName: "ZCode Computer Use",
  };
}
export function createInstaller(options = {}) {
  const dependencies = { ...verifierDependencies, ...options.dependencies };
  const verify = async (appPath) => {
    const identity = await helperIdentity(appPath);
    const metadata = await stat(identity.executablePath);
    if (!metadata.isFile()) throw new CuaError("invalid_artifact", "Native executable is missing");
    const resolved = await realpath(identity.executablePath);
    const child = relative(identity.appPath, resolved);
    if (child.startsWith("..") || isAbsolute(child))
      throw new CuaError("invalid_artifact", "Native executable escaped the app bundle");
    const manifest = JSON.parse(
      await readFile(
        join(
          process.platform === "win32" ? identity.appPath : dirname(identity.appPath),
          "runtime-manifest.json",
        ),
        "utf8",
      ),
    );
    if (
      manifest.protocol !== "zcode-cua/1" ||
      manifest.platform !== process.platform ||
      !manifest.architectures?.includes(process.arch)
    )
      throw new CuaError(
        "incompatible_artifact",
        "Native runtime protocol or architecture is incompatible",
      );
    if (
      createHash("sha256")
        .update(await readFile(resolved))
        .digest("hex") !== manifest.sha256
    )
      throw new CuaError("artifact_integrity", "Native runtime integrity check failed");
    if (process.platform === "win32") {
      const [major, , build] = release().split(".").map(Number);
      if (
        !Number.isFinite(build) ||
        major < 10 ||
        build < 19041 ||
        manifest.transport !== "stdio-exe"
      )
        throw new CuaError("unsupported_system", "Windows 10 build 19041 or newer is required");
      const binary = await readFile(resolved);
      const offset = binary.readUInt32LE(0x3c);
      if (offset + 6 > binary.length || binary.toString("ascii", offset, offset + 4) !== "PE\0\0")
        throw new CuaError("invalid_artifact", "Native runtime is not a valid PE executable");
      const arch =
        binary.readUInt16LE(offset + 4) === 0xaa64
          ? "arm64"
          : binary.readUInt16LE(offset + 4) === 0x8664
            ? "x64"
            : "unknown";
      if (arch !== process.arch)
        throw new CuaError(
          "incompatible_artifact",
          "Native runtime architecture does not match this machine",
        );
      return identity.appPath;
    }
    const [major, minor] = release().split(".").map(Number);
    if (major < 23 || (major === 23 && minor < 4))
      throw new CuaError("unsupported_system", "macOS 14.4 or newer is required");
    await dependencies.verifyCodeSignature(identity.appPath);
    await dependencies.verifyTeamIdentifier(identity.appPath, options.teamIdentifier);
    const architectures = await dependencies.readExecutableArchs(resolved);
    if (!architectures.includes(process.arch))
      throw new CuaError(
        "incompatible_artifact",
        "Native executable architecture does not match this machine",
      );
    return identity.appPath;
  };
  return {
    async ensureInstalled() {
      if (!options.bundledAppPath)
        throw new CuaError(
          "missing_artifact",
          "This installation is missing its Computer Control runtime",
        );
      return verify(options.bundledAppPath);
    },
    async verifyInstalled(appPath) {
      await verify(appPath);
    },
  };
}
