// Modified by ZCode Feiyu.
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { parse as parseToml } from "smol-toml";
import type {
  ExternalImportResource,
  ExternalImportSource,
  ExternalImportItemResult,
} from "@zcode/shared";
import { object, text } from "../domain/history.js";
import { atomicPrivateFile } from "./privateState.js";
import { containedPath, digest, walkFiles } from "./sourceFiles.js";
import { sensitive, resourceRevision, copyResource } from "./resourceFiles.js";
import { detectAdditionalMcp, mcpImportReason } from "./extraMcp.js";
import { acquireFileLock } from "@zcode/shared/node";

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
async function sourceConfig(
  source: ExternalImportSource,
  root: string,
  configPath?: string,
): Promise<Record<string, unknown>> {
  const path = configPath || join(root, source === "codex" ? "config.toml" : "settings.json");
  if (!(await exists(path))) return {};
  const raw = await readFile(await containedPath(root, path), "utf8");
  return object(path.endsWith(".toml") ? parseToml(raw) : JSON.parse(raw));
}
export async function detectResources(
  source: ExternalImportSource,
  root: string,
  targetRoot: string,
  signal: AbortSignal,
  workspacePath?: string,
): Promise<ExternalImportResource[]> {
  const result: ExternalImportResource[] = [];
  const targetConfigPath = workspacePath
    ? join(targetRoot, "config.json")
    : join(targetRoot, "cli", "config.json");
  const instructions = join(workspacePath || root, source === "codex" ? "AGENTS.md" : "CLAUDE.md");
  const add = async (
    kind: ExternalImportResource["kind"],
    name: string,
    path: string,
    target: string,
    reason?: string,
  ) => {
    let revision = "";
    try {
      revision =
        kind === "mcpServers"
          ? digest(
              JSON.stringify(
                object(
                  object(await sourceConfig(source, root))[
                    source === "codex" ? "mcp_servers" : "mcpServers"
                  ],
                )[name],
              ),
            )
          : await resourceRevision(
              workspacePath && path === instructions ? workspacePath : root,
              path,
              signal,
            );
    } catch (error) {
      reason = error instanceof Error ? error.message : "resource_read_failed";
    }
    result.push({
      key: digest(`${source}:${root}:${kind}:${path}:${name}`),
      kind,
      name,
      sourcePath: path,
      targetPath: target,
      available: !reason,
      reason,
      revision,
      sourceRoot: workspacePath && path === instructions ? workspacePath : root,
      workspacePath,
    });
  };
  for (const [kind, directory, marker] of [
    ["skills", "skills", "SKILL.md"],
    ["commands", "commands", ".md"],
    ["plugins", "plugins", "plugin.json"],
  ] as const) {
    for (const file of await walkFiles(join(root, directory), marker, signal)) {
      if (kind === "skills" && basename(file) !== "SKILL.md") continue;
      const path =
        kind === "commands" ? file : kind === "plugins" ? dirname(dirname(file)) : dirname(file);
      const name = basename(path);
      const compatible =
        kind !== "plugins" ||
        [".zcode-plugin", ".claude-plugin", ".codex-plugin"].some((marker) =>
          file.endsWith(join(marker, "plugin.json")),
        );
      await add(
        kind,
        name,
        path,
        join(
          targetRoot,
          directory,
          kind === "commands" ? relative(join(root, directory), file) : name,
        ),
        compatible ? undefined : "plugin_format_incompatible",
      );
    }
  }
  if (await exists(instructions))
    await add("instructions", "AGENTS.md", instructions, join(targetRoot, "AGENTS.md"));
  for (const file of await walkFiles(join(root, "projects"), "MEMORY.md", signal))
    await add(
      "memory",
      basename(dirname(file)),
      file,
      join(targetRoot, "imported-memory", `${digest(file).slice(0, 16)}.md`),
    );
  let config: Record<string, unknown>;
  try {
    config = await sourceConfig(source, root);
  } catch {
    config = {};
    result.push({
      key: digest(`${root}:invalid-config`),
      kind: "settings",
      name: "Settings",
      sourcePath: root,
      targetPath: targetRoot,
      available: false,
      revision: "",
      reason: "resource_json_invalid",
    });
  }
  const configPath = join(root, source === "codex" ? "config.toml" : "settings.json");
  if (Object.keys(config).length)
    await add(
      "settings",
      "Settings",
      configPath,
      targetConfigPath,
      "source_settings_require_explicit_mapping",
    );
  const servers = object(source === "codex" ? config.mcp_servers : config.mcpServers);
  for (const [name, server] of Object.entries(servers)) {
    const reason = mcpImportReason(server);
    await add("mcpServers", name, configPath, targetConfigPath, reason);
  }
  result.push(...(await detectAdditionalMcp(source, root, targetConfigPath, workspacePath)));
  return result;
}
async function readTargetConfig(path: string): Promise<Record<string, unknown>> {
  try {
    return object(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("target_config_invalid", { cause: error });
  }
}
export async function importResource(
  resource: ExternalImportResource,
  source: ExternalImportSource,
  root: string,
  signal: AbortSignal,
): Promise<ExternalImportItemResult> {
  const result: ExternalImportItemResult = {
    key: resource.key,
    label: resource.name,
    status: "imported",
    targetPath: resource.targetPath,
  };
  if (!resource.available) return { ...result, status: "skipped", reason: resource.reason };
  if (resource.kind === "mcpServers") {
    const config = await sourceConfig(source, root, resource.sourcePath);
    const server = object(
      object(source === "codex" ? config.mcp_servers : config.mcpServers)[resource.name],
    );
    if (digest(JSON.stringify(server)) !== resource.revision)
      throw new Error("source_changed_rescan_required");
    const reason = mcpImportReason(server);
    if (reason) return { ...result, status: "skipped", reason };
    await mkdir(dirname(resource.targetPath), { recursive: true, mode: 0o700 });
    const release = await acquireFileLock(resource.targetPath, [50, 100], 1000, 10000);
    try {
      const target = await readTargetConfig(resource.targetPath);
      const mcp = object(target.mcp);
      const servers = object(mcp.servers);
      if (Object.keys(servers).some((name) => name.toLowerCase() === resource.name.toLowerCase()))
        return { ...result, status: "conflict", reason: "target_exists" };
      const converted = server.command
        ? {
            type: "stdio",
            command: text(server.command),
            args: Array.isArray(server.args) ? server.args : [],
            env: object(server.env),
          }
        : {
            type: server.type === "sse" ? "sse" : "http",
            url: text(server.url),
            headers: object(server.headers ?? server.http_headers),
          };
      // 导入配置不代表授权执行，复用运行时已有 enabled 开关，避免新会话自动启动来源 MCP。
      const imported = { ...converted, enabled: false };
      await atomicPrivateFile(
        resource.targetPath,
        JSON.stringify(
          { ...target, mcp: { ...mcp, servers: { ...servers, [resource.name]: imported } } },
          null,
          2,
        ),
      );
      result.warnings = ["mcp_imported_enable_in_settings"];
      return result;
    } finally {
      await release();
    }
  }
  if (resource.kind === "instructions" && resource.sourcePath === resource.targetPath)
    return { ...result, status: "skipped", reason: "instructions_already_available" };
  if (await exists(resource.targetPath)) {
    if (
      resource.kind === "plugins" &&
      (await resourceRevision(dirname(resource.targetPath), resource.targetPath, signal)) ===
        resource.revision
    ) {
      try {
        await registerImportedPlugin(resource);
      } catch (error) {
        if (error instanceof Error && error.message === "plugin_id_conflict")
          return { ...result, status: "conflict", reason: "plugin_id_conflict" };
        throw error;
      }
      return {
        ...result,
        status: "skipped",
        reason: "already_imported",
        warnings: ["plugin_copied_enable_in_settings"],
      };
    }
    return { ...result, status: "conflict", reason: "target_exists" };
  }
  try {
    await copyResource(root, resource.sourcePath, resource.targetPath, resource.revision, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return { ...result, status: "conflict", reason: "target_exists" };
    throw error;
  }
  if (resource.kind === "plugins") {
    try {
      await registerImportedPlugin(resource);
    } catch (error) {
      if (error instanceof Error && error.message === "plugin_id_conflict")
        return { ...result, status: "conflict", reason: "plugin_id_conflict" };
      throw error;
    }
    result.warnings = ["plugin_copied_enable_in_settings"];
  }
  if (resource.kind === "memory") result.warnings = ["memory_imported_for_review"];
  return result;
}

export async function readMcpReview(
  resource: ExternalImportResource,
  source: ExternalImportSource,
  root: string,
): Promise<string> {
  const config = await sourceConfig(source, root, resource.sourcePath);
  const server = object(
    object(source === "codex" ? config.mcp_servers : config.mcpServers)[resource.name],
  );
  if (sensitive(server)) throw new Error("requires_reauthorization");
  if (digest(JSON.stringify(server)) !== resource.revision)
    throw new Error("source_changed_rescan_required");
  return JSON.stringify({ name: resource.name, server }, null, 2);
}

export async function registerImportedPlugin(resource: ExternalImportResource): Promise<void> {
  const markers = [".zcode-plugin", ".claude-plugin", ".codex-plugin"];
  const marker = (
    await Promise.all(
      markers.map(async (name) =>
        (await exists(join(resource.targetPath, name, "plugin.json"))) ? name : undefined,
      ),
    )
  ).find(Boolean);
  const manifest = marker
    ? object(JSON.parse(await readFile(join(resource.targetPath, marker, "plugin.json"), "utf8")))
    : {};
  const name = text(manifest.name);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(name)) throw new Error("plugin_format_incompatible");
  const targetRoot = dirname(dirname(resource.targetPath));
  const configPath = resource.workspacePath
    ? join(targetRoot, "config.json")
    : join(targetRoot, "cli", "config.json");
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const release = await acquireFileLock(configPath, [50, 100], 1000, 10000);
  try {
    const config = await readTargetConfig(configPath);
    const plugins = object(config.plugins);
    const dirs = Array.isArray(plugins.dirs)
      ? plugins.dirs.filter((item) => typeof item === "string")
      : [];
    if (dirs.includes(resource.targetPath)) return;
    if (`${name}@inline` in object(plugins.enabledPlugins)) throw new Error("plugin_id_conflict");
    for (const path of dirs)
      for (const marker of markers) {
        const file = join(path, marker, "plugin.json");
        if ((await exists(file)) && object(JSON.parse(await readFile(file, "utf8"))).name === name)
          throw new Error("plugin_id_conflict");
      }
    await atomicPrivateFile(
      configPath,
      JSON.stringify(
        {
          ...config,
          plugins: {
            ...plugins,
            dirs: [...new Set([...dirs, resource.targetPath])],
            enabledPlugins: { ...object(plugins.enabledPlugins), [`${name}@inline`]: false },
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await release();
  }
}
