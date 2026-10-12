// Modified by ZCode Feiyu.
import {
  PROTOCOL_V4_LIMITS,
  v4ConversationUnsubscribeParamsSchema,
  parseConversationTopic,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
} from "@zcode/shared/zcode-protocol-v4";
import { subscriptionRouteKey } from "./v4-gateway-conversation-v4-gateway-options.js";
import type { ConversationV4Gateway } from "./v4-gateway.js";

export function pruneBinaryReadCache(this: ConversationV4Gateway, now = this["now"]()): void {
  for (const [key, entry] of this["binaryReadCache"]) {
    if (now - entry.accessedAt > PROTOCOL_V4_LIMITS.attachmentReadCacheTtlMs) {
      this["deleteBinaryReadCacheEntry"](key);
    }
  }
  if (this["binaryReadCacheBytes"] <= PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes) return;
  const oldest = [...this["binaryReadCache"].entries()]
    .filter(([, entry]) => entry.bytes !== null)
    .sort((left, right) => left[1].accessedAt - right[1].accessedAt);
  for (const [key] of oldest) {
    this["deleteBinaryReadCacheEntry"](key);
    if (this["binaryReadCacheBytes"] <= PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes) break;
  }
}

export function deleteBinaryReadCacheEntry(this: ConversationV4Gateway, key: string): void {
  const entry = this["binaryReadCache"].get(key);
  if (!entry) return;
  this["binaryReadCache"].delete(key);
  this["binaryReadCacheBytes"] = Math.max(0, this["binaryReadCacheBytes"] - (entry.bytes ?? 0));
}

export function unsubscribe(this: ConversationV4Gateway, rawParams: unknown): void {
  const params = v4ConversationUnsubscribeParamsSchema.parse(rawParams);
  const sessionId = parseConversationTopic(params.topic);
  if (sessionId === null) {
    const workspaceId = parseSessionsIndexTopic(params.topic);
    if (workspaceId !== null) {
      this["indexPublishers"]
        .get(workspaceId)
        ?.unsubscribe(params.subscriptionId, params.connectionId);
      return;
    }
    const configWorkspaceId = parseWorkspaceConfigTopic(params.topic);
    if (configWorkspaceId !== null) {
      this["configPublishers"]
        .get(configWorkspaceId)
        ?.unsubscribe(params.subscriptionId, params.connectionId);
    }
    return;
  }
  const routeKey = subscriptionRouteKey(params.topic, params.subscriptionId, params.connectionId);
  const state = this["flushStates"].get(routeKey);
  if (!state) return;
  if (state?.timer) clearTimeout(state.timer);
  this["flushStates"].delete(routeKey);
  // 裸 subscriptionId 在不同 topic/connection 可碰撞；旧网关先按 subId
  // 反查再对三类 publisher 广撒网，会删掉别的连接。topic + connection 必须同时命中。
  this["publishers"].get(sessionId)?.unsubscribe(params.subscriptionId, params.connectionId);
}
