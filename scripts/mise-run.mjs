import { spawn } from "node:child_process";

import { withPinnedNodePath } from "./mise-toolchain-env.mjs";

const [requestedCommand, ...args] = process.argv.slice(2);
if (!requestedCommand) {
  console.error("Usage: node scripts/mise-run.mjs <command> [...args]");
  process.exit(1);
}

// Windows 上 pnpm 是 .cmd 文件；其他平台直接使用 pnpm 可执行入口。
const command =
  process.platform === "win32" && requestedCommand === "pnpm" ? "pnpm.cmd" : requestedCommand;
const child = spawn(command, args, {
  cwd: process.cwd(),
  env: withPinnedNodePath(process.env, process.execPath),
  // Windows 的 .cmd 入口需要 shell 才能被 Node spawn。
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`[mise-run] failed to start ${requestedCommand}: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
