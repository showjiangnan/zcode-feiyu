// Modified by ZCode Feiyu.
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const MAX_PLUGIN_MANIFEST_SEARCH_DEPTH = 5;

export const PLUGIN_MANIFEST_RELATIVE_PATHS = [
  ".zcode-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
] as const;

export async function readPluginNameForSkillRoot(
  skillRootPath: string,
): Promise<string | undefined> {
  let current = resolve(skillRootPath);
  for (let depth = 0; depth <= MAX_PLUGIN_MANIFEST_SEARCH_DEPTH; depth++) {
    for (const relativePath of PLUGIN_MANIFEST_RELATIVE_PATHS) {
      const pluginName = await readPluginNameFromManifest(join(current, relativePath));
      if (pluginName) return pluginName;
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export async function readPluginNameFromManifest(
  manifestPath: string,
): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: unknown };
    return typeof manifest.name === "string" && manifest.name.trim().length > 0
      ? manifest.name.trim()
      : undefined;
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    return undefined;
  }
}

export function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
