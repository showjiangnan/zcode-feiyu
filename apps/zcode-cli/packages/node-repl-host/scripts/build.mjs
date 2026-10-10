// Modified by ZCode Feiyu contributors (2026).
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { NODE_REPL_SERVER_VERSION } from "../src/tool-contract.ts";

const packageRoot = resolve(import.meta.dirname, "..");

// 见 browser-use-plugin/scripts/build.mjs 的同名修复：esbuild 的 esm 产物里
// __require shim 在 ESM 作用域没有 require 可用，@zcode/core 拖进来的 CJS 依赖（yaml →
// require("process")）会在**模块求值阶段**抛错，plugin host 的 await import() 直接失败，
// 表现为注册 0 个工具、模型侧完全看不到 mcp__node_repl__js。注入真实 createRequire。
const nodeRequireBanner = `import { createRequire as __zcodeCreateRequire } from "node:module";
const require = __zcodeCreateRequire(import.meta.url);`;

// Node REPL 使用 Host 已验证的本地原生运行时；bundle 不下载或自行安装 Helper。
export const buildNodeReplHostBundle = async ({
  outfile = resolve(packageRoot, "dist", "mcp", "server.js"),
} = {}) => {
  // 只更新 package/常量却漏改插件 manifest 曾把旧版本装入生产包，构建阶段必须阻断。
  const pkg = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, ".zcode-plugin/plugin.json"), "utf8"),
  );
  if (pkg.version !== manifest.version || pkg.version !== NODE_REPL_SERVER_VERSION)
    throw new Error("Node REPL package, plugin manifest and serverInfo versions must match");
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    banner: { js: nodeRequireBanner },
    bundle: true,
    entryPoints: [resolve(packageRoot, "src", "server.ts")],
    format: "esm",
    legalComments: "none",
    outfile,
    platform: "node",
    target: "node24",
  });
  return { outfile };
};

// 这里原先写成 `file://${process.argv[1]}`。
// Windows 上 argv[1] 是 `C:\...\build.mjs`，而 import.meta.url 是 `file:///C:/.../build.mjs`，
// 两者永远不相等 —— 脚本被当成纯模块导入，什么都不做就退出：构建"成功"却没有产物，
// 直到 dev 守卫报「build succeeded without required MCP runtime」才暴露。
// browser-use 的同名脚本与仓库其他入口都用 pathToFileURL，抽包时我漏了这一处。
const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const { outfile } = await buildNodeReplHostBundle();
  console.log(`[node-repl-host] ${outfile}`);
}
