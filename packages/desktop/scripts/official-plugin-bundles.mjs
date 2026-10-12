// Modified by ZCode Feiyu.
// 内置插件的打包清单与运行时生产者共享名称；资源搬运仍由原打包入口负责。
export function createOfficialPluginBundles(browserUseRequiredRuntimePaths) {
  return [
    {
      packageName: "@zcode/zcode-cua-plugin",
      relativePath: "packages/zcode-cua-plugin",
      requiresRuntime: false,
      requiredRuntimePaths: [
        "docs/computer-use.md",
        "scripts/computer-use-client.mjs",
        "skills/computer-use/SKILL.md",
      ],
      stagedPath: "packages/zcode-cua-plugin",
    },
    {
      packageName: "@zcode/android-emulator-plugin",
      relativePath: "apps/zcode-cli/packages/android-emulator-plugin",
      requiresRuntime: true,
      requiredRuntimePaths: ["dist/mcp/server.js"],
      runtimeBuildScript: "scripts/build-mcp.mjs",
      stagedPath: "packages/android-emulator-plugin",
    },
    {
      packageName: "@zcode/documents-plugin",
      relativePath: "apps/zcode-cli/packages/documents-plugin",
      requiresRuntime: false,
      requiredSeedPaths: ["agents/visual-judge.md", "skills/docx/SKILL.md"],
      stagedPath: "packages/documents-plugin",
    },
    {
      packageName: "@zcode/image-search-plugin",
      relativePath: "apps/zcode-cli/packages/image-search-plugin",
      requiresRuntime: false,
      requiredSeedPaths: [".mcp.json"],
      stagedPath: "packages/image-search-plugin",
    },
    {
      packageName: "@zcode/pdf-plugin",
      relativePath: "apps/zcode-cli/packages/pdf-plugin",
      requiresRuntime: false,
      requiredSeedPaths: ["agents/visual-judge.md", "skills/pdf/SKILL.md"],
      stagedPath: "packages/pdf-plugin",
    },
    {
      packageName: "@zcode/presentations-plugin",
      relativePath: "apps/zcode-cli/packages/presentations-plugin",
      requiresRuntime: false,
      requiredSeedPaths: ["agents/visual-judge.md", "skills/pptx/SKILL.md"],
      stagedPath: "packages/presentations-plugin",
    },
    {
      packageName: "@zcode/spreadsheets-plugin",
      relativePath: "apps/zcode-cli/packages/spreadsheets-plugin",
      requiresRuntime: false,
      requiredSeedPaths: ["agents/visual-judge.md", "skills/xlsx/SKILL.md"],
      stagedPath: "packages/spreadsheets-plugin",
    },
    {
      packageName: "@zcode/visualize-plugin",
      relativePath: "apps/zcode-cli/packages/visualize-plugin",
      requiresRuntime: false,
      requiredSeedPaths: [
        "skills/visualize/SKILL.md",
        "skills/visualize/references/api.md",
        "skills/visualize/references/styles.md",
        "skills/visualize/tweak.md",
        "skills/visualize/LICENSE.md",
        "skills/visualize/scripts/render.py",
        "skills/visualize/assets/visualize.css",
        "skills/visualize/assets/visualize.html",
        "skills/visualize/assets/calendar.js",
        "skills/visualize/assets/runtime-manifest.json",
        "skills/visualize/scripts/vendor.py",
        "skills/visualize/assets/vendor/manifest.json",
        "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js",
        "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js.LICENSE",
        "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js",
        "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js.LICENSE",
        "skills/visualize/assets/vendor/lucide-1.17.0.js",
        "skills/visualize/assets/vendor/lucide-1.17.0.js.LICENSE",
        "skills/visualize/assets/vendor/d3-7.9.0.min.js",
        "skills/visualize/assets/vendor/d3-7.9.0.min.js.LICENSE",
        "skills/visualize/widgets/calendar.md",
        "skills/visualize/examples/calendar.html",
        "skills/visualize/assets/standalone-host-bridge.js",
        "skills/visualize/assets/standalone-shell.js",
      ],
      requiredRuntimePaths: [],
      stagedPath: "packages/visualize-plugin",
    },
    {
      // browser-use 只携带自己的 client script 与 skill/docs；node_repl MCP runtime 归
      // @zcode/node-repl-host（见上方常量注释）。
      packageName: "@zcode/browser-use-plugin",
      relativePath: "apps/zcode-cli/packages/browser-use-plugin",
      requiresRuntime: true,
      requiredRuntimePaths: browserUseRequiredRuntimePaths,
      runtimeBuildScript: "scripts/build.mjs",
      stagedPath: "packages/browser-use-plugin",
    },
    {
      packageName: "@zcode/ios-simulator-plugin",
      relativePath: "apps/zcode-cli/packages/ios-simulator-plugin",
      requiresRuntime: true,
      requiredRuntimePaths: ["dist/mcp/server.js"],
      runtimeBuildScript: "scripts/build-mcp.mjs",
      stagedPath: "packages/ios-simulator-plugin",
    },
    {
      // 修复原因：restore-legacy-sessions 已注册为官方插件，但 Electron 生产包只会拷贝
      // 这里列出的资源。漏掉它会导致用户生产包首次启动后 plugins list 里看不到该插件。
      packageName: "@zcode/restore-legacy-sessions-plugin",
      relativePath: "apps/zcode-cli/packages/restore-legacy-sessions-plugin",
      requiresRuntime: false,
      stagedPath: "packages/restore-legacy-sessions-plugin",
    },
    {
      packageName: "@zcode/skill-creator-plugin",
      relativePath: "apps/zcode-cli/packages/skill-creator-plugin",
      requiresRuntime: false,
      stagedPath: "packages/skill-creator-plugin",
    },
    {
      packageName: "@zcode/plugin-creator-plugin",
      relativePath: "apps/zcode-cli/packages/plugin-creator-plugin",
      requiresRuntime: false,
      stagedPath: "packages/plugin-creator-plugin",
    },
    {
      // 修复原因：zcode-guide 已注册为官方默认启用内容型插件（见 official-plugin-definitions.ts）。
      // Electron 生产包不是 SEA 路径，官方插件 seed 依赖这里 stage 的 resources/glm/packages/*-plugin；
      // 漏掉它会导致生产桌面包首启 seed 不到该插件，用户拿不到默认启用的配置指南技能。
      packageName: "@zcode/zcode-guide-plugin",
      relativePath: "apps/zcode-cli/packages/zcode-guide-plugin",
      requiresRuntime: false,
      stagedPath: "packages/zcode-guide-plugin",
    },
    {
      // node_repl 宿主：Browser Use 与 Computer Use 共用的 MCP runtime，本轮抽成独立包。
      // 它没有 listing（不进插件市场展示面），但生产包首启 seed 必须拿到它的 dist runtime，
      // 否则 bua/cua 任一开启时都会连不上 node_repl。
      packageName: "@zcode/node-repl-host",
      relativePath: "apps/zcode-cli/packages/node-repl-host",
      requiresRuntime: true,
      requiredRuntimePaths: ["dist/mcp/server.js"],
      runtimeBuildScript: "scripts/build.mjs",
      stagedPath: "packages/node-repl-host",
    },
    // superpowers 已从内置插件下线，改走 UI 推荐区按需安装；这里不再 stage 它的资源。
  ];
}
