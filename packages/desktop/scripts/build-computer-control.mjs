// Modified by ZCode Feiyu contributors (2026).
import { readdir, mkdir, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { getTargetPlatform } from "./target-platform.mjs";
import { verifyComputerControlVersions } from "./computer-control-versions.mjs";

const root = resolve(import.meta.dirname, "../../..");
await verifyComputerControlVersions(root);
// 原生版本曾写死，导致新插件携带旧 manifest；统一使用 producer 发布版本。
const { version: packageVersion } = JSON.parse(
  await readFile(join(root, "packages/zcode-cua/package.json"), "utf8"),
);
const target = getTargetPlatform();
const output = resolve(import.meta.dirname, "../dist-cua-helper");
function run(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? accept() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
if (target.os === "darwin") {
  if (process.platform !== "darwin") throw new Error("Build the macOS control runtime on macOS");
  const bundle = join(output, "ZCode Computer Use.app");
  const contents = join(bundle, "Contents");
  const executable = join(contents, "MacOS", "zcode-computer-control");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(contents, "Resources"), { recursive: true });
  const source = join(root, "packages/zcode-cua/native/macos");
  const files = (await readdir(source))
    .filter((name) => name.endsWith(".swift"))
    .map((name) => join(source, name));
  await run("/usr/bin/swiftc", [
    "-swift-version",
    "5",
    "-parse-as-library",
    "-O",
    "-target",
    `${target.arch === "x64" ? "x86_64" : target.arch}-apple-macosx14.4`,
    ...files,
    "-framework",
    "AppKit",
    "-framework",
    "ApplicationServices",
    "-framework",
    "ScreenCaptureKit",
    "-framework",
    "Carbon",
    "-o",
    executable,
  ]);
  await writeFile(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.zcode.cua-helper</string><key>CFBundleExecutable</key><string>zcode-computer-control</string><key>CFBundleName</key><string>ZCode Computer Use</string><key>CFBundleDisplayName</key><string>ZCode Computer Use</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${packageVersion}</string><key>CFBundleShortVersionString</key><string>${packageVersion}</string><key>LSMinimumSystemVersion</key><string>14.4</string><key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/></dict></plist>`,
  );
  await run("/usr/bin/codesign", [
    "--force",
    "--sign",
    process.env.CSC_NAME || "-",
    "--options",
    "runtime",
    bundle,
  ]);
  const sha256 = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  await writeFile(
    join(output, "runtime-manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        protocol: "zcode-cua/1",
        packageVersion,
        platform: "darwin",
        architectures: [target.arch],
        minimumOSVersion: "14.4",
        sha256,
      },
      null,
      2,
    ),
  );
} else if (target.os === "win32") {
  if (process.platform !== "win32")
    throw new Error("Build Windows Computer Control with the Windows SDK and MSVC on Windows");
  const source = join(root, "packages/zcode-cua/native/windows");
  const build = join(output, "build");
  await mkdir(output, { recursive: true });
  await run("cmake", ["-S", source, "-B", build, "-A", target.arch === "arm64" ? "ARM64" : "x64"]);
  await run("cmake", ["--build", build, "--config", "Release"]);
  const { copyFile, rm } = await import("node:fs/promises");
  const executable = join(output, "zcode-computer-control.exe");
  await copyFile(join(build, "Release", "zcode-computer-control.exe"), executable);
  if (process.env.ZCODE_WINDOWS_CUA_SIGNTOOL)
    await run(process.env.ZCODE_WINDOWS_CUA_SIGNTOOL, ["sign", "/a", "/fd", "SHA256", executable]);
  const sha256 = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  await writeFile(
    join(output, "runtime-manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        protocol: "zcode-cua/1",
        transport: "stdio-exe",
        packageVersion,
        platform: "win32",
        architectures: [target.arch],
        minimumOSVersion: "10.0.19041",
        sha256,
      },
      null,
      2,
    ),
  );
  await rm(build, { recursive: true, force: true });
}
