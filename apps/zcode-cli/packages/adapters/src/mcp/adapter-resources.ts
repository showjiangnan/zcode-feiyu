// Modified by ZCode Feiyu.
import type {
  McpCallToolOptions,
  McpListResourcesRequest,
  McpListResourcesResult,
  McpListResourceTemplatesResult,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpResourceSubscriptionRequest,
} from "@zcode/contracts";
import { McpResourceSubscribeUnsupportedError } from "@zcode/contracts";
import type { NodeMcpAdapter } from "./adapter-owner.js";
import {
  DEFAULT_MCP_TIMEOUT_MS,
  isRecord,
  McpClient,
  McpServerRecord,
  pickResourceDescriptor,
} from "./adapter-shared.js";
import { createMcpDeadline, remainingMcpDeadlineMs, type McpDeadline } from "./timeout.js";

export async function listResources(
  this: NodeMcpAdapter,
  request: McpListResourcesRequest,
  options: McpCallToolOptions = {},
): Promise<McpListResourcesResult> {
  const { record, deadline, timeoutMessage } = await this.resolveForResourceRequest(
    request.serverName,
    "resources/list",
    options,
  );
  const result = await record.client.listResources(
    request.cursor ? { cursor: request.cursor } : {},
    { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
  );
  return {
    resources: (result.resources ?? []).map((resource) => {
      const { uri, ...rest } = pickResourceDescriptor(resource);
      return { uri: uri ?? "", ...rest };
    }),
    ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
  };
}

export async function listResourceTemplates(
  this: NodeMcpAdapter,
  request: McpListResourcesRequest,
  options: McpCallToolOptions = {},
): Promise<McpListResourceTemplatesResult> {
  const { record, deadline, timeoutMessage } = await this.resolveForResourceRequest(
    request.serverName,
    "resources/templates/list",
    options,
  );
  const result = await record.client.listResourceTemplates(
    request.cursor ? { cursor: request.cursor } : {},
    { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
  );
  return {
    resourceTemplates: (result.resourceTemplates ?? []).map((template) => {
      const item = template as Record<string, unknown>;
      return {
        uriTemplate: typeof item.uriTemplate === "string" ? item.uriTemplate : "",
        ...pickResourceDescriptor(item, false),
      };
    }),
    ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
  };
}

export async function subscribeResource(
  this: NodeMcpAdapter,
  request: McpResourceSubscriptionRequest,
  options: McpCallToolOptions = {},
): Promise<void> {
  const { record, deadline, timeoutMessage } = await this.resolveForResourceRequest(
    request.serverName,
    "resources/subscribe",
    options,
  );
  if (!record.client.getServerCapabilities()?.resources?.subscribe) {
    throw new McpResourceSubscribeUnsupportedError(request.serverName);
  }
  const { first } = this.resourceSubscriptions.add(
    request.serverName,
    request.uri,
    request.subscriberKey,
  );
  if (!first) return;
  try {
    await record.client.subscribeResource(
      { uri: request.uri },
      { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
    );
  } catch (error) {
    this.resourceSubscriptions.remove(request.serverName, request.uri, request.subscriberKey);
    throw error;
  }
  this.logger?.info("MCP resource subscribed", {
    event: "mcp.resource.subscribe",
    mcpServerName: request.serverName,
    uri: request.uri,
    status: "completed",
  });
}

export async function unsubscribeResource(
  this: NodeMcpAdapter,
  request: McpResourceSubscriptionRequest,
  options: McpCallToolOptions = {},
): Promise<void> {
  const removed = this.resourceSubscriptions.remove(
    request.serverName,
    request.uri,
    request.subscriberKey,
  );
  if (!removed?.last) return;
  await this.unsubscribeOnServer(request.serverName, request.uri, options);
}

export async function unsubscribeResourcesBySubscriber(
  this: NodeMcpAdapter,
  subscriberKeyPrefix: string,
): Promise<number> {
  const released = this.resourceSubscriptions.removeByPrefix(subscriberKeyPrefix);
  for (const { serverName, uri } of released) {
    await this.unsubscribeOnServer(serverName, uri, {});
  }
  return released.length;
}

export function resourceSubscriptionCounts(
  this: NodeMcpAdapter,
): Record<string, Record<string, number>> {
  return this.resourceSubscriptions.counts();
}

export async function unsubscribeOnServer(
  this: NodeMcpAdapter,
  serverName: string,
  uri: string,
  options: McpCallToolOptions,
): Promise<void> {
  const record = this.records.get(serverName);
  if (!record?.client || record.status.status !== "connected") return;
  try {
    await record.client.unsubscribeResource({ uri }, { signal: options.signal });
    this.logger?.info("MCP resource unsubscribed", {
      event: "mcp.resource.unsubscribe",
      mcpServerName: serverName,
      uri,
      status: "completed",
    });
  } catch (error) {
    // 退订失败只记日志：登记表已清，server 多发的通知因没有订阅者会被丢弃。
    this.logger?.warn("MCP resource unsubscribe failed", {
      event: "mcp.resource.unsubscribe",
      mcpServerName: serverName,
      uri,
      error: error instanceof Error ? error.message : String(error),
      status: "failed",
    });
  }
}

export async function replayResourceSubscriptions(
  this: NodeMcpAdapter,
  serverName: string,
  client: McpClient,
): Promise<void> {
  const uris = this.resourceSubscriptions.uris(serverName);
  if (uris.length === 0) return;
  if (!client.getServerCapabilities()?.resources?.subscribe) return;
  for (const uri of uris) {
    try {
      await client.subscribeResource({ uri });
    } catch (error) {
      this.logger?.warn("MCP resource subscription replay failed", {
        event: "mcp.resource.subscribe",
        mcpServerName: serverName,
        uri,
        error: error instanceof Error ? error.message : String(error),
        status: "failed",
      });
    }
  }
  this.logger?.info("MCP resource subscriptions replayed after reconnect", {
    event: "mcp.resource.subscribe.replayed",
    mcpServerName: serverName,
    uriCount: uris.length,
  });
}

export async function resolveForResourceRequest(
  this: NodeMcpAdapter,
  serverName: string,
  operation: string,
  options: McpCallToolOptions,
): Promise<{
  record: McpServerRecord & { client: McpClient };
  deadline: McpDeadline;
  timeoutMessage: string;
}> {
  const timeoutMs =
    options.timeoutMs ?? this.records.get(serverName)?.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const deadline = createMcpDeadline(timeoutMs);
  const timeoutMessage = `MCP ${operation} ${serverName} timed out after ${timeoutMs}ms`;
  const record = await this.resolveConnectedRecord(
    serverName,
    deadline,
    timeoutMessage,
    options.signal,
  );
  return { record, deadline, timeoutMessage };
}

export async function readResource(
  this: NodeMcpAdapter,
  request: McpReadResourceRequest,
  options: McpCallToolOptions = {},
): Promise<McpReadResourceResult> {
  const timeoutMs =
    options.timeoutMs ??
    this.records.get(request.serverName)?.config.timeoutMs ??
    DEFAULT_MCP_TIMEOUT_MS;
  const deadline = createMcpDeadline(timeoutMs);
  const timeoutMessage = `MCP resource ${request.serverName} ${request.uri} timed out after ${timeoutMs}ms`;
  const record = await this.resolveConnectedRecord(
    request.serverName,
    deadline,
    timeoutMessage,
    options.signal,
  );
  const result = await record.client.readResource(
    { uri: request.uri },
    { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
  );
  return {
    contents: (result.contents ?? []).map((content) => {
      const item = content as Record<string, unknown>;
      return {
        uri: typeof item.uri === "string" ? item.uri : request.uri,
        ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
        ...(typeof item.text === "string" ? { text: item.text } : {}),
        ...(typeof item.blob === "string" ? { blob: item.blob } : {}),
        ...(isRecord(item._meta) ? { _meta: item._meta } : {}),
      };
    }),
  };
}
