// Modified by ZCode Feiyu contributors (2026).
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// producer 是发布权威；CLI 注册路径曾漏更新，必须在生成任何安装资产前拒绝漂移。
export async function verifyComputerControlVersions(root) {
  const json = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));
  const producer = await json("packages/zcode-cua/package.json");
  const paths = [
    "packages/zcode-cua-plugin/package.json",
    "packages/zcode-cua-plugin/.zcode-plugin/plugin.json",
    "apps/zcode-cli/packages/node-repl-host/package.json",
    "apps/zcode-cli/packages/node-repl-host/.zcode-plugin/plugin.json",
  ];
  for (const path of paths) {
    const value = await json(path);
    if (value.version !== producer.version)
      throw new Error(`Computer control version mismatch: ${path}`);
  }
  const source = await readFile(
    join(root, "apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts"),
    "utf8",
  );
  for (const name of ["OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME", "OFFICIAL_CUA_PLUGIN_NAME"]) {
    const version = source.match(new RegExp(`name: ${name},[\\s\\S]*?version: "([^"]+)"`))?.[1];
    if (version !== producer.version)
      throw new Error(`Computer control version mismatch: CLI ${name}`);
  }
  const host = await readFile(
    join(root, "apps/zcode-cli/packages/node-repl-host/src/tool-contract.ts"),
    "utf8",
  );
  if (host.match(/NODE_REPL_SERVER_VERSION = "([^"]+)"/)?.[1] !== producer.version)
    throw new Error("Computer control version mismatch: Node REPL server");
  return producer.version;
}
