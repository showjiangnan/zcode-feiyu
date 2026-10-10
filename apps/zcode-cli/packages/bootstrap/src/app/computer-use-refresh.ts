// Modified by ZCode Feiyu contributors (2026).
import { createConfig } from "@zcode/adapters/config";
import { buildPluginReferenceCatalog, type AgentRuntime } from "@zcode/core";
import type {
  Logger,
  McpServerConfig,
  PluginLoadOutcome,
  SkillPort,
  SkillRoot,
  TraceContext,
} from "@zcode/contracts";
import { resolveZCodePlugins } from "../plugins.js";
import { omitMcpServers } from "../mcp-config.js";
import { createConfigCliOverrides, resolveEffectiveConfigResult } from "./app-config-options.js";
import { resolveBuiltInNodeReplMcpServers } from "./built-in-node-repl.js";
import { OFFICIAL_CUA_PLUGIN_ID } from "./official-plugin-definitions.js";
import type { ZCodeAppOptions } from "./types.js";

type Catalog = ReturnType<typeof buildPluginReferenceCatalog>;

/** 官方 CUA 按现有执行边界刷新；其他插件快照与 Browser session 不在这里重建。 */
export function createComputerUseRefresh(input: {
  initial: PluginLoadOutcome;
  options: ZCodeAppOptions;
  workingDirectory: string;
  getRuntime: () => AgentRuntime;
  logger: Logger;
  createSkillPort: (roots: SkillRoot[]) => SkillPort | undefined;
  decorateServers: (servers: Record<string, McpServerConfig>) => Record<string, McpServerConfig>;
  onApplied: (server: McpServerConfig | undefined, catalog: Catalog) => void;
}): (trace: TraceContext) => Promise<void> {
  let currentPlugin = input.initial.plugins.find((plugin) => plugin.id === OFFICIAL_CUA_PLUGIN_ID);
  let flight: Promise<void> | undefined;
  return async (trace) => {
    if (flight) return await flight;
    if (input.getRuntime().getActiveTurnInfo()) return;
    const run = async () => {
      const configResult = resolveEffectiveConfigResult(
        createConfig({
          env: input.options.env,
          projectConfigPath: input.options.projectConfigPath,
          workingDirectory: input.workingDirectory,
          workspaceIdentity: input.options.runtimeConfig?.memory?.workspaceIdentity,
          skipUserConfig: input.options.skipUserConfig,
          userConfigPath: input.options.userConfigPath,
          cliOverrides: createConfigCliOverrides(input.options),
        }),
        input.options,
      );
      const fresh = resolveZCodePlugins({
        configResult,
        env: input.options.env,
        workingDirectory: input.workingDirectory,
        officialPluginRoots: input.options.officialPluginRoots,
        pluginStorageRoot: input.options.pluginStorageRoot,
        logger: input.logger,
      });
      const nextPlugin = fresh.plugins.find((plugin) => plugin.id === OFFICIAL_CUA_PLUGIN_ID);
      if (
        nextPlugin?.enabled === currentPlugin?.enabled &&
        nextPlugin?.rootPath === currentPlugin?.rootPath &&
        nextPlugin?.version === currentPlugin?.version
      )
        return;
      const selected: PluginLoadOutcome = {
        ...input.initial,
        plugins: [
          ...input.initial.plugins.filter((plugin) => plugin.id !== OFFICIAL_CUA_PLUGIN_ID),
          ...(nextPlugin ? [nextPlugin] : []),
        ],
        skillRoots: [
          ...input.initial.skillRoots.filter((root) => root.pluginId !== OFFICIAL_CUA_PLUGIN_ID),
          ...fresh.skillRoots.filter((root) => root.pluginId === OFFICIAL_CUA_PLUGIN_ID),
        ],
      };
      const builtIn = resolveBuiltInNodeReplMcpServers({
        pluginOutcome: selected,
        workingDirectory: input.workingDirectory,
      });
      const servers = input.decorateServers(
        omitMcpServers(
          builtIn,
          new Set(),
          nextPlugin?.enabled ? new Set(["node_repl"]) : new Set(),
        ),
      );
      const catalog = buildPluginReferenceCatalog(selected.plugins);
      const applied = await input.getRuntime().refreshComputerUse({
        enabled: nextPlugin?.enabled === true,
        nodeReplServer: servers.node_repl,
        skillPort: input.createSkillPort(selected.skillRoots),
        pluginReferenceCatalog: catalog,
        trace,
      });
      if (!applied) return;
      currentPlugin = nextPlugin;
      input.onApplied(servers.node_repl, catalog);
      input.logger.info("Computer Control capability refreshed at task boundary", {
        event: "bootstrap.computer_use.refreshed",
        enabled: nextPlugin?.enabled === true,
        sessionId: trace.sessionId,
      });
    };
    flight = run();
    try {
      await flight;
    } finally {
      flight = undefined;
    }
  };
}
