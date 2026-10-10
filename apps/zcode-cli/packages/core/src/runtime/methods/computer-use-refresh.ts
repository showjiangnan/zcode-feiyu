// Modified by ZCode Feiyu contributors (2026).
import type { McpServerConfig, SkillPort, TraceContext } from "../deps.js";
import type { AgentRuntimeConfig } from "../types.js";
import { registerMcpTools } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { computeOfficialCuaServerNames } from "./mcp.js";

const NODE_REPL_SERVER = "node_repl";
const NODE_REPL_TOOL = "mcp__node_repl__js";

export interface ComputerUseRefreshInput {
  enabled: boolean;
  skillPort?: SkillPort;
  nodeReplServer?: McpServerConfig;
  pluginReferenceCatalog?: AgentRuntimeConfig["pluginReferenceCatalog"];
  trace: TraceContext;
}

/** 官方能力按合法执行边界刷新，不能在正在使用旧工具/观察的回合中替换绑定。 */
export async function refreshComputerUse(
  this: AgentRuntimeInternal,
  input: ComputerUseRefreshInput,
): Promise<boolean> {
  if (this.activeTurn) return false;
  await this.initializeMcp(input.trace);
  if (this.activeTurn) return false;
  if (input.nodeReplServer && this.mcpPort && this.config.mcp?.enabled !== false) {
    const status = await this.mcpPort.connectServer(NODE_REPL_SERVER, input.nodeReplServer, {
      trace: input.trace,
      workingDirectory: this.workspaceRoot,
      workspaceIdentity: this.config.workspaceIdentity?.toString(),
    });
    if (status.status !== "connected") {
      throw new Error("Computer Control host connection could not be refreshed");
    }
    const tools = (await this.mcpPort.listTools()).filter(
      (tool) => tool.serverName === NODE_REPL_SERVER,
    );
    this.registry.unregister(NODE_REPL_TOOL);
    registerMcpTools(this.registry, this.mcpPort, tools, {
      allowedTools: this.config.toolAllowlist,
      disallowedTools: this.config.toolDisallowlist,
      workspaceCuaApproval: {
        serverNames: computeOfficialCuaServerNames(
          { [NODE_REPL_SERVER]: input.nodeReplServer },
          new Set([NODE_REPL_SERVER]),
        ),
        isEnabled: () => this.config.runtimeFeatures?.computerUse === true,
      },
    });
  } else if (!input.nodeReplServer) {
    await this.mcpPort?.disconnectServer(NODE_REPL_SERVER);
    this.registry.unregister(NODE_REPL_TOOL);
  }
  this.config.runtimeFeatures = { ...this.config.runtimeFeatures, computerUse: input.enabled };
  if (this.config.mcp && input.nodeReplServer) {
    this.config.mcp.servers = {
      ...this.config.mcp.servers,
      [NODE_REPL_SERVER]: input.nodeReplServer,
    };
  } else if (this.config.mcp?.servers) {
    delete this.config.mcp.servers[NODE_REPL_SERVER];
  }
  if (input.pluginReferenceCatalog)
    this.config.pluginReferenceCatalog = input.pluginReferenceCatalog;
  this.skillPort = input.skillPort;
  if (this.contextInitialized) {
    this.skillLoadOutcome = await this.discoverSkillsForContext(input.trace);
    // 只替换 owner 前缀；既有对话、压缩与记忆内容由原来的 history/context 合同保留。
    rebuildContextPrefix(this);
  }
  this.invalidateToolCache();
  return true;
}
