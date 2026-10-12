// Modified by ZCode Feiyu.
import { spawn } from "node:child_process";

export function gitFileNames(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const files = [];
    let pending = "";
    let stderr = "";
    // CI 持久缓存曾让 execFile 的 1 MiB 输出缓冲区溢出；流式消费路径，NUL 分隔避免转义和空白损坏。
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const names = (pending + chunk).split("\0");
      pending = names.pop() ?? "";
      for (const name of names) if (name) files.push(name);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16 * 1024);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} failed (${signal ?? code}): ${stderr.trim()}`));
        return;
      }
      if (pending) files.push(pending);
      resolve(files);
    });
  });
}
