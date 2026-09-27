import { spawnSync } from "node:child_process";

const windowsShellCommandPattern = /\.(cmd|bat)$/i;
const windowsShellCommandNames = new Set(["npm", "pnpm"]);

export function resolveSpawnRuntimeOptions(command, platform = process.platform) {
  if (
    platform === "win32" &&
    (windowsShellCommandPattern.test(command) || windowsShellCommandNames.has(command))
  ) {
    return {
      // Windows runner 上 bare `pnpm` / `npm` 实际也是通过 cmd shim 提供。
      // 之前先把命令名改写成 `pnpm.cmd`，会让部分 `pnpm exec` 场景重新落回错误的包 cwd，
      // 最终把 tsup 入口解析成 scripts/src/... 并报“Cannot find src/main/index.ts”。
      // 这里保留原始命令名，只要求 shell/cmd.exe 负责解析 shim，避免再次改变 pnpm 的包上下文。
      shell: true,
    };
  }

  return {};
}

// shell:true 时 Node 只把 args 按空格拼接进命令行、不做转义（对应 DEP0190 警告）。
// Windows 上仓库路径含空格时（如 E:\Z Code\...），pnpm --dir 的路径会被 cmd 按空格
// 截断成 E:\Z 并报 ENOENT: lstat。这里按 cmd.exe 规则给含空格的参数补双引号；
// 无空格参数保持原样，不影响现有无空格路径与 CI 行为。
export function quoteArgsForWindowsShell(args) {
  return args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg));
}

export function runCommand(command, args, options = {}) {
  const runtimeOptions = resolveSpawnRuntimeOptions(command);
  const spawnArgs = runtimeOptions.shell ? quoteArgsForWindowsShell(args) : args;
  const result = spawnSync(command, spawnArgs, {
    stdio: "inherit",
    ...options,
    ...runtimeOptions,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}`);
  }

  return result;
}

export function runCommandAndReadStdout(command, args, options = {}) {
  const runtimeOptions = resolveSpawnRuntimeOptions(command);
  const spawnArgs = runtimeOptions.shell ? quoteArgsForWindowsShell(args) : args;
  const result = spawnSync(command, spawnArgs, {
    encoding: "utf8",
    ...options,
    ...runtimeOptions,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}`);
  }

  return result.stdout;
}
