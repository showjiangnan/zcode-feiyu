// Modified by ZCode Feiyu contributors (2026).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
export function blockingDesktopProcesses(snapshot, appName) {
  // 先采集完整快照，再筛 executable；grep/等待脚本的正文不能误报为运行中的 Host。
  return snapshot.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) return [];
    const executable = match[3];
    return executable.includes(`/${appName}/Contents/`) ||
      /^zcode-(?:host-local-|cli(?:\s|$))/u.test(basename(executable))
      ? [{ pid: Number(match[1]), executable }]
      : [];
  });
}
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function running(appName) {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,comm="]);
  const blocked = blockingDesktopProcesses(stdout, appName);
  // 部分 Agent 使用 node 的 executable，但 process title/启动参数指向安装包。
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+\d+\s+(.+)$/u.exec(line);
    if (!match || !/^(?:node|bun)$/u.test(basename(match[2]))) continue;
    const args = await exec("/bin/ps", ["-p", match[1], "-o", "args="]).catch(() => ({
      stdout: "",
    }));
    if (
      /^\s*zcode-(?:host-local-|cli(?:\s|$))/u.test(args.stdout) ||
      args.stdout.includes(`/${appName}/Contents/Resources/glm/zcode.cjs`)
    )
      blocked.push({ pid: Number(match[1]), executable: match[2] });
  }
  return blocked;
}
async function verify(app, expected) {
  if ((await lstat(app)).isSymbolicLink()) throw new Error("Application path cannot be a symlink");
  const identity = (
    await exec("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleIdentifier",
      join(app, "Contents/Info.plist"),
    ])
  ).stdout.trim();
  if (identity !== expected.identity) throw new Error("Application identity mismatch");
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  await exec("/usr/bin/lipo", [
    join(app, "Contents/MacOS", basename(app, ".app")),
    "-verify_arch",
    "arm64",
  ]);
  for (const [file, hash] of [
    ["glm/zcode.cjs", expected.agent],
    ["app.asar", expected.asar],
  ]) {
    if ((await sha256(join(app, "Contents/Resources", file))) !== hash)
      throw new Error(`Installed digest mismatch: ${file}`);
  }
}
export async function installLocalDesktop({ app, target, identity, agent, asar }) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("This installer requires macOS arm64");
  app = resolve(app);
  target = resolve(target);
  if (app === target || !target.endsWith(".app")) throw new Error("Invalid install target");
  const expected = { identity, agent, asar };
  await verify(app, expected);
  const blockers = await running(basename(target));
  if (blockers.length)
    throw new Error(
      `Quit ${basename(target)} before installation; blocking PIDs: ${blockers.map((item) => item.pid).join(", ")}`,
    );
  const existing = await lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink()) throw new Error("Install target cannot be a symlink");
    const id = (
      await exec("/usr/libexec/PlistBuddy", [
        "-c",
        "Print :CFBundleIdentifier",
        join(target, "Contents/Info.plist"),
      ])
    ).stdout.trim();
    if (id !== identity)
      throw new Error("Refusing to replace an application with a different identity");
  }
  await access(dirname(target));
  const stage = await mkdtemp(join(dirname(target), ".zcode-local-install-"));
  const candidate = join(stage, basename(target));
  const backup = join(stage, "previous.app");
  let moved = false,
    installed = false;
  try {
    await exec("/usr/bin/ditto", [app, candidate]);
    await verify(candidate, expected);
    if ((await running(basename(target))).length)
      throw new Error("Application started during staging");
    if (existing) {
      await rename(target, backup);
      moved = true;
    }
    await rename(candidate, target);
    installed = true;
    await verify(target, expected);
  } catch (error) {
    if (installed) await rename(target, candidate);
    if (moved) await rename(backup, target);
    await rm(stage, { recursive: true });
    throw error;
  }
  // 校验后的安装已提交；清理失败保留新版与回滚目录，不能在删除旧 app 的半途误回滚。
  let cleanupDeferred;
  try {
    await rm(stage, { recursive: true });
  } catch {
    cleanupDeferred = stage;
  }
  return { target, identity, agent, asar, ...(cleanupDeferred ? { cleanupDeferred } : {}) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [app, target, identity, agent, asar] = process.argv.slice(2);
  if (
    !app ||
    !target ||
    !identity ||
    !/^[a-f0-9]{64}$/u.test(agent ?? "") ||
    !/^[a-f0-9]{64}$/u.test(asar ?? "")
  )
    throw new Error(
      "Usage: node scripts/install-local-desktop.mjs <app> <target> <bundle-id> <agent-sha256> <asar-sha256>",
    );
  console.log(JSON.stringify(await installLocalDesktop({ app, target, identity, agent, asar })));
}
