import { delimiter, dirname } from "node:path";

/**
 * 让所有子进程使用和启动器相同的 Node runtime。
 *
 * `mise run` 通过 shell 执行 TOML task；当另一套 Node 出现在
 * 子 shell 的 PATH 前面时，pnpm 会用错误的 runtime 启动 package script，
 * 即使 task 本身已经由 mise 选中了正确版本。把启动器的 Node 目录置首，
 * 可以在不依赖用户 home 目录布局的前提下固定整条子进程链路。
 */
export function withPinnedNodePath(env, nodeExecutablePath) {
  const nodeDirectory = dirname(nodeExecutablePath);
  // Windows 的 Node 环境对象通常使用 `Path`，只读取大写 `PATH` 会把 pnpm.cmd
  // 所在目录从子进程环境中丢掉，导致 dev:desktop 的内部 pnpm 调用失败。
  const pathKey = typeof env.PATH === "string" ? "PATH" : "Path";
  const existingPath = typeof env[pathKey] === "string" ? env[pathKey] : "";
  const pathEntries = existingPath
    .split(delimiter)
    .filter(Boolean)
    .filter((entry) => entry !== nodeDirectory);

  return {
    ...env,
    [pathKey]: [nodeDirectory, ...pathEntries].join(delimiter),
  };
}
