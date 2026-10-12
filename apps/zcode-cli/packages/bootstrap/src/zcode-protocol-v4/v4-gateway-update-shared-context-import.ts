// Modified by ZCode Feiyu.
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { v4ConnectionFlowParamsSchema } from "@zcode/shared/zcode-protocol-v4";
import type { SessionEvent } from "@zcode/contracts";
import { MAX_TELEMETRY_EVENT_IDS } from "./v4-gateway-conversation-v4-gateway-options.js";
import type { ConversationV4Gateway } from "./v4-gateway.js";

export function updateSharedContextImport(
  this: ConversationV4Gateway,
  sessionId: string,
  source: ConversationSnapshot["sharedContextImport"],
): void {
  const publisher = this["publishers"].get(sessionId);
  if (!publisher) return;
  publisher.seedSharedContextImport(source);
  for (const [routeKey, state] of this["flushStates"]) {
    if (state.sessionId === sessionId) this["scheduleFlush"](routeKey, state, publisher);
  }
}

export function setConnectionFlowState(this: ConversationV4Gateway, rawParams: unknown): void {
  const params = v4ConnectionFlowParamsSchema.parse(rawParams);
  if (params.state === "closed") {
    this["pausedConnections"].delete(params.connectionId);
    this["clearConnectionFlushTimers"](params.connectionId);
    this["attachmentUploads"].clearConnection(params.connectionId);
    return;
  }
  if (params.state === "saturated") {
    if (this["pausedConnections"].has(params.connectionId)) return;
    this["pausedConnections"].add(params.connectionId);
    this["clearConnectionFlushTimers"](params.connectionId);
    return;
  }
  if (!this["pausedConnections"].delete(params.connectionId)) return;
  this["flushConnection"](params.connectionId);
}

export function clearConnectionFlushTimers(
  this: ConversationV4Gateway,
  connectionId: string,
): void {
  for (const state of this["flushStates"].values()) {
    if (state.connectionId !== connectionId || state.timer === null) continue;
    clearTimeout(state.timer);
    state.timer = null;
  }
}

export function flushConnection(this: ConversationV4Gateway, connectionId: string): void {
  for (const [routeKey, state] of this["flushStates"]) {
    if (state.connectionId !== connectionId) continue;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    const publisher = this["publishers"].get(state.sessionId);
    if (!publisher?.hasSubscription(state.subscriptionId, connectionId)) {
      this["flushStates"].delete(routeKey);
      continue;
    }
    const reservation = publisher.reserveFlush(state.subscriptionId);
    if (!reservation) continue;
    try {
      this["emitReservation"](reservation);
    } catch (error) {
      this["host"].onError?.("v4.frame.emit", error);
    }
  }
  for (const workspaceId of this["indexPublishers"].keys()) {
    this["flushIndex"](workspaceId, connectionId);
  }
  for (const workspaceId of this["configPublishers"].keys()) {
    this["flushConfig"](workspaceId, connectionId);
  }
}

export function ingest(this: ConversationV4Gateway, sessionId: string, event: SessionEvent): void {
  if (this["disposed"]) return;
  const hydrationBuffer = this["hydrationBuffers"].get(sessionId);
  if (hydrationBuffer) {
    const eventId = String(event.id);
    if (hydrationBuffer.eventIds.has(eventId)) return;
    // 先记 raw fact；它可能因前序尚未到而暂时不进 publisher。
    hydrationBuffer.eventIds.add(eventId);
    hydrationBuffer.rawEvents.push(event);
  }
  this["emitLiveTelemetryFact"](sessionId, event);
  for (const normalizedEvent of this["normalizeRuntimeEventSequence"](sessionId, event)) {
    try {
      this["localTtft"].event(sessionId, normalizedEvent);
    } catch (error) {
      try {
        this["host"].onError?.("v4.localTtft.observe", error);
      } catch {
        /* 诊断回调也不能阻断实际内容。 */
      }
    }
    this["ingestNormalizedEvent"](sessionId, normalizedEvent);
  }
}

export function emitLiveTelemetryFact(
  this: ConversationV4Gateway,
  sessionId: string,
  event: SessionEvent,
): void {
  const eventId = String(event.id);
  // 主 session 与 detached child 各自维护事件序列，eventId 不能假设跨
  // session 全局唯一。旧去重只用 eventId，会把 child 的同号事件误判成主会话重放，
  // 导致前台 Subagent 的真实轮次事实被静默丢弃。
  const telemetryEventKey = `${sessionId}\0${eventId}`;
  if (this["telemetryEventIds"].has(telemetryEventKey)) return;
  this["telemetryEventIds"].add(telemetryEventKey);
  if (this["telemetryEventIds"].size > MAX_TELEMETRY_EVENT_IDS) {
    const oldest = this["telemetryEventIds"].values().next().value;
    if (typeof oldest === "string") this["telemetryEventIds"].delete(oldest);
  }
  try {
    const config =
      this["publishers"].get(sessionId)?.getSnapshot().config ??
      this["host"].getSessionConfigSeed?.(sessionId) ??
      undefined;
    const fact = this["telemetryNormalizer"].normalize(sessionId, event, {
      memoryEnabled: this["host"].getSessionMemoryEnabled?.(sessionId),
      modelName: config?.model,
      modelProvider: config?.provider,
    });
    if (fact) {
      this["host"].emitConversationTelemetryFact?.(fact);
    }
  } catch (error) {
    // 轮次事实绝不能反向阻断 conversation 投影；严格 schema 失败只记录诊断。
    this["host"].onError?.("v4.telemetry.normalize", error);
  }
  try {
    const observation = this["cuaPermissionNormalizer"].normalize(sessionId, event);
    if (observation) this["host"].emitCuaPermissionObservation?.(observation);
  } catch (error) {
    // 权限观察只是 live UI 提示，schema 或投影异常不能阻断 conversation 主链路。
    this["host"].onError?.("v4.cuaPermissionObservation.normalize", error);
  }
}
