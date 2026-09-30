// Modified by ZCode Feiyu contributors (2026).
/**
 * resources/glm 的 electron-builder extraResources 条目。
 *
 * electron-builder 的拷贝过滤器会无条件丢弃 from 目录顶层的 node_modules
 * （app-builder-lib util/filter.js 对 relative === "node_modules" 直接返回 false），
 * 因此 glm 下已暂存的原生依赖必须以各自包目录作为独立 from，才能进入安装包。
 */
export const BUNDLED_AGENT_NATIVE_PACKAGES = ["koffi"];

export function bundledAgentExtraResources(platformKey) {
  const glm = `bundled-agents/${platformKey}/glm`;
  return [
    {
      // agent 运行时资产，打包到 resources/glm。
      // 桌面端内置的是 agent 的 JS bundle（glm/zcode.cjs，由 prepare:agent-bundle 生成），
      // Host 进程用 app 自带的 Electron Node runtime（ELECTRON_RUN_AS_NODE）执行 `zcode.cjs app-server --stdio`，
      // 不再随包内置独立 Node 二进制。远端 SSH/WSL 仍走原生二进制（无 Electron）。
      from: glm,
      to: "glm",
      filter: ["**/*", "!**/*.map"],
    },
    // 修复：受控记忆 Worker 依赖的 koffi 位于 glm/node_modules，原单一 glm 条目会被上述规则过滤，
    // afterPack 的 verifyStagedKoffi 因而拦下安装包。
    ...BUNDLED_AGENT_NATIVE_PACKAGES.map((name) => ({
      from: `${glm}/node_modules/${name}`,
      to: `glm/node_modules/${name}`,
      filter: ["**/*"],
    })),
  ];
}
