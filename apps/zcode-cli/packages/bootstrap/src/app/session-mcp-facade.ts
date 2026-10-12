// Modified by ZCode Feiyu.
import { McpResourceSubscribeUnsupportedError, resolveMcpToolVisibility } from "@zcode/contracts";
import { createMcpAppProvidedToolEntry, createMcpToolEntry, toMcpToolName } from "@zcode/core";

import { listMcpServerStatuses } from "../mcp-config.js";

import type { CreateSessionFacadeDeps, SessionFacade } from "./session-facade-types.js";

// 派生方法复用既有依赖；本功能的闭包状态只在这个工厂创建一次。
export function createSessionMcpFacade(
  deps: CreateSessionFacadeDeps,
): Pick<
  SessionFacade,
  | "listMcpServers"
  | "connectMcpServer"
  | "readMcpResource"
  | "readMcpResourceForUi"
  | "listMcpResourcesForUi"
  | "listMcpResourceTemplatesForUi"
  | "subscribeMcpResourceForUi"
  | "unsubscribeMcpResourceForUi"
  | "unsubscribeMcpResourcesForUi"
  | "onMcpAppConnectionInvalidated"
  | "getMcpAppConnectionSnapshot"
  | "callMcpToolForUi"
  | "replaceMcpAppProvidedTools"
  | "getMcpToolVisibility"
  | "disconnectMcpServer"
> {
  // App-Provided Tools：本会话当前登记在 ToolRegistry 里的模型侧名字（整体替换时先注销）。
  let appProvidedToolNames: string[] = [];
  return {
    listMcpServers: async () =>
      listMcpServerStatuses(
        deps.mcpPort,
        deps.configuredMcpServers,
        deps.untrustedProjectMcpServers,
      ),

    connectMcpServer: async (name) => {
      const config = deps.configuredMcpServers[name];
      if (!config) {
        throw new Error(`MCP server is not configured: ${name}`);
      }
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      return deps.mcpPort.connectServer(name, config, {
        trace: deps.traceContext,
        workingDirectory: deps.workingDirectory,
      });
    },

    readMcpResource: async (serverName, uri, options) => {
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      if (!deps.mcpPort.readResource) {
        throw new Error("MCP resources are not supported by this runtime");
      }
      return deps.mcpPort.readResource(
        { serverName, uri, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },

    readMcpResourceForUi: async (serverName, uri, options) => {
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      if (!deps.mcpPort.readResource) {
        throw new Error("MCP resources are not supported by this runtime");
      }
      return deps.mcpPort.readResource(
        { serverName, uri, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },

    listMcpResourcesForUi: async (serverName, cursor, options) => {
      if (!deps.mcpPort) throw new Error("MCP is disabled");
      if (!deps.mcpPort.listResources) {
        throw new McpResourceSubscribeUnsupportedError(serverName);
      }
      return deps.mcpPort.listResources(
        { serverName, ...(cursor ? { cursor } : {}), trace: deps.traceContext },
        { signal: options?.signal },
      );
    },

    listMcpResourceTemplatesForUi: async (serverName, cursor, options) => {
      if (!deps.mcpPort) throw new Error("MCP is disabled");
      if (!deps.mcpPort.listResourceTemplates) {
        throw new McpResourceSubscribeUnsupportedError(serverName);
      }
      return deps.mcpPort.listResourceTemplates(
        { serverName, ...(cursor ? { cursor } : {}), trace: deps.traceContext },
        { signal: options?.signal },
      );
    },

    subscribeMcpResourceForUi: async (serverName, uri, subscriberKey, options) => {
      if (!deps.mcpPort) throw new Error("MCP is disabled");
      if (!deps.mcpPort.subscribeResource) {
        throw new McpResourceSubscribeUnsupportedError(serverName);
      }
      await deps.mcpPort.subscribeResource(
        { serverName, uri, subscriberKey, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },

    unsubscribeMcpResourceForUi: async (serverName, uri, subscriberKey, options) => {
      if (!deps.mcpPort?.unsubscribeResource) return;
      await deps.mcpPort.unsubscribeResource(
        { serverName, uri, subscriberKey, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },

    unsubscribeMcpResourcesForUi: async (subscriberKeyPrefix) => {
      if (!deps.mcpPort?.unsubscribeResourcesBySubscriber) return 0;
      return deps.mcpPort.unsubscribeResourcesBySubscriber(subscriberKeyPrefix);
    },

    onMcpAppConnectionInvalidated: (name, listener) =>
      deps.mcpPort?.onAppConnectionInvalidated?.(name, listener) ?? (() => {}),

    getMcpAppConnectionSnapshot: (name) => deps.mcpPort?.appConnectionSnapshot?.(name) ?? null,

    callMcpToolForUi: async (serverName, toolName, args, options) => {
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      const snapshot = deps.mcpPort.appConnectionSnapshot?.(serverName);
      if (!snapshot) throw new Error("MCP App connection is unavailable");
      const descriptor = (await deps.mcpPort.listTools()).find(
        (tool) => tool.serverName === serverName && tool.toolName === toolName,
      );
      if (!descriptor || !resolveMcpToolVisibility(descriptor).includes("app"))
        throw new Error("Tool is not available to this App");
      const registry = deps.runtime.getToolRegistry();
      const registered = registry
        .list()
        .map((name) => registry.get(name))
        .find(
          (entry) =>
            entry?.metadata.mcpPresentation?.serverName === serverName &&
            entry.metadata.mcpPresentation.toolName === toolName,
        );
      const entry =
        registered ??
        createMcpToolEntry(toMcpToolName(descriptor), descriptor, deps.mcpPort, false);
      const executor = deps.runtime.getToolExecutor();
      if (!executor.authorizeAppTool) throw new Error("MCP App host authorization is unavailable");
      const input = await executor.authorizeAppTool(
        { id: crypto.randomUUID(), name: entry.metadata.name, input: args ?? {} },
        entry,
        { signal: options?.signal, traceContext: deps.traceContext },
      );
      // 审批期间连接可能被替换：批准只属于原连接，执行前必须再次验证。
      options?.signal?.throwIfAborted();
      const current = deps.mcpPort.appConnectionSnapshot?.(serverName);
      if (
        !current ||
        current.identity !== snapshot.identity ||
        current.generation !== snapshot.generation
      )
        throw new Error("MCP App connection changed during authorization");
      return deps.mcpPort.callTool(
        {
          serverName,
          toolName,
          arguments: input as Record<string, unknown>,
          trace: deps.traceContext,
          runtimeScope: "main",
        },
        { signal: options?.signal, appConnection: snapshot },
      );
    },

    replaceMcpAppProvidedTools: (definitions, execute) => {
      const registry = deps.runtime.getToolRegistry();
      for (const name of appProvidedToolNames) registry.unregister(name);
      const registered: string[] = [];
      for (const definition of definitions) {
        // 不覆盖内置 / MCP 工具：`app__` 前缀本不该冲突，冲突时以既有工具为准。
        if (registry.has(definition.modelName) || registered.includes(definition.modelName))
          continue;
        registry.register(createMcpAppProvidedToolEntry(definition, execute), {
          silentDuplicateWarning: true,
        });
        registered.push(definition.modelName);
      }
      appProvidedToolNames = registered;
      // 同回合下一次模型请求即可见：只是让 getTools 重建缓存；工具集合没变时发给模型的内容也不变。
      deps.runtime.invalidateToolCache();
      return registered;
    },

    getMcpToolVisibility: async (serverName, toolName) => {
      if (!deps.mcpPort) return null;
      // 真相是 adapter 归一化过的 descriptor（同一份 tools/list），不另存副本。
      const descriptor = (await deps.mcpPort.listTools()).find(
        (tool) => tool.serverName === serverName && tool.toolName === toolName,
      );
      return descriptor ? resolveMcpToolVisibility(descriptor) : null;
    },

    disconnectMcpServer: async (name) => {
      if (!deps.mcpPort) return undefined;
      return deps.mcpPort.disconnectServer(name);
    },
  };
}
