// Modified by ZCode Feiyu contributors (2026).
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
export { persistentGrants } from "./application-grants.js";

const PLUGIN = "computer-use@zcode-plugins-official";
const LEGACY_PLUGIN = "zcode-cua@zcode-plugins-official";
async function read(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}
export async function pluginEnabled(options = {}) {
  const home = options.env?.HOME || options.env?.USERPROFILE || homedir();
  const paths = [
    join(home, ".zcode", "cli", "config.json"),
    ...(options.configPaths ||
      (options.workingDirectory ? [join(options.workingDirectory, ".zcode", "config.json")] : [])),
  ];
  let enabled = false;
  for (const path of paths) {
    const config = await read(path);
    const values = config.plugins?.enabledPlugins || {};
    const value = values[PLUGIN] ?? values[LEGACY_PLUGIN];
    if (typeof value === "boolean") enabled = value;
  }
  return enabled;
}
