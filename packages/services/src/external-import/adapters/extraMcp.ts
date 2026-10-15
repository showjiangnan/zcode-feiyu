// Modified by ZCode Feiyu.
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ExternalImportResource, ExternalImportSource } from "@zcode/shared";
import { object, text } from "../domain/history.js";
import { importPathIdentity } from "../domain/identity.js";
import { sensitive } from "./resourceFiles.js";
import { containedPath, digest } from "./sourceFiles.js";
export function mcpImportReason(server: unknown): string | undefined {
  if (sensitive(server)) return "requires_reauthorization";
  const value = object(server);
  if (
    value.type &&
    ((value.command && value.type !== "stdio") || (!value.command && value.type === "stdio"))
  )
    return "unsupported_mcp_transport";
  if (value.command) {
    if (
      typeof value.command !== "string" ||
      (value.args !== undefined &&
        (!Array.isArray(value.args) || value.args.some((item) => typeof item !== "string"))) ||
      Object.values(object(value.env)).some((item) => typeof item !== "string")
    )
      return "unsupported_mcp_transport";
  } else {
    try {
      const url = new URL(text(value.url));
      if (!["https:", "http:"].includes(url.protocol)) return "unsupported_mcp_transport";
    } catch {
      return "unsupported_mcp_transport";
    }
  }
  if (value.type && !["stdio", "http", "sse", "streamableHttp"].includes(text(value.type)))
    return "unsupported_mcp_transport";
  return undefined;
}
export function additionalMcpFiles(
  source: ExternalImportSource,
  root: string,
  workspacePath?: string,
  userHome = homedir(),
): string[] {
  if (source !== "claudeCode") return [];
  if (workspacePath) return [join(workspacePath, ".mcp.json")];
  return importPathIdentity(root, process.platform) ===
    importPathIdentity(resolve(userHome, ".claude"), process.platform)
    ? [join(userHome, ".claude.json")]
    : [];
}
export async function detectAdditionalMcp(
  source: ExternalImportSource,
  root: string,
  targetPath: string,
  workspacePath?: string,
): Promise<ExternalImportResource[]> {
  const result: ExternalImportResource[] = [];
  for (const path of additionalMcpFiles(source, root, workspacePath)) {
    const sourceRoot = dirname(path);
    try {
      const config = object(
        JSON.parse(await readFile(await containedPath(sourceRoot, path), "utf8")),
      );
      for (const [name, server] of Object.entries(object(config.mcpServers))) {
        const reason = mcpImportReason(server);
        result.push({
          key: digest(`${source}:${root}:mcpServers:${path}:${name}`),
          kind: "mcpServers",
          name,
          sourcePath: path,
          sourceRoot,
          workspacePath,
          targetPath,
          revision: digest(JSON.stringify(server)),
          available: !reason,
          reason,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        result.push({
          key: digest(path),
          kind: "mcpServers",
          name: "MCP",
          sourcePath: path,
          targetPath,
          available: false,
          revision: "",
          reason: "resource_json_invalid",
        });
    }
  }
  return result;
}
