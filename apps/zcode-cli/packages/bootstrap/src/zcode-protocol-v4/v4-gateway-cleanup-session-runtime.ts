// Modified by ZCode Feiyu.
import { ProjectionEventCommitWaitError } from "./v4-gateway-conversation-v4-gateway-options.js";
import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import type { ConversationV4Gateway } from "./v4-gateway.js";

export function cleanupSessionRuntime(
  this: ConversationV4Gateway,
  sessionId: string,
  options: {
    clearCommandInbox: boolean;
    notifyIndexRemoved: boolean;
  },
): void {
  if (options.clearCommandInbox) {
    // 清掉 in-flight/live 命令会破坏幂等与 FIFO。resident facts 已在回收前
    // 拦截；若这里仍命中，必须在拆 publisher 之前失败，不能留下半清状态。
    this.assertSessionRuntimeDeactivatable(sessionId);
  }
  this["rejectProjectionEventWaiters"](
    sessionId,
    new ProjectionEventCommitWaitError(
      "fault.projectionEventCommit.disposed",
      `conversation session disposed while waiting for projection event commit: ${sessionId}`,
    ),
  );
  this["attachmentUploads"].clearSession(sessionId);
  for (const [key, entry] of this["binaryReadCache"]) {
    if (entry.sessionId === sessionId) this["deleteBinaryReadCacheEntry"](key);
  }
  if (options.notifyIndexRemoved) {
    // 先取 workspaceId（会话 record 还在时），把 session.removed 推给列表订阅者。
    try {
      const workspaceId = this["host"].getSessionWorkspaceId?.(sessionId) ?? null;
      if (workspaceId !== null) {
        const indexPublisher = this["indexPublishers"].get(workspaceId);
        // 无订阅者时也必须先更新 projection，避免已有 publisher 在下次
        // subscribe 的 snapshot 中复活已删除会话；flushIndex 对空订阅自然 no-op。
        if (indexPublisher?.removeSession(sessionId)) {
          this["flushIndex"](workspaceId);
        }
      }
    } catch (error) {
      this["host"].onError?.("v4.sessionsIndex.remove", error);
    }
  }
  this["indexFanoutThrottle"].clearSession(sessionId);
  for (const [routeKey, state] of this["flushStates"]) {
    if (state.sessionId !== sessionId) continue;
    if (state.timer) clearTimeout(state.timer);
    this["flushStates"].delete(routeKey);
  }
  this["publishers"].delete(sessionId);
  this["hydratedSessions"].delete(sessionId);
  const hydrationBuffer = this["hydrationBuffers"].get(sessionId);
  if (hydrationBuffer) hydrationBuffer.cancelled = true;
  this["hydrationBuffers"].delete(sessionId);
  this["hydrationInFlight"].delete(sessionId);
  this["readyFlights"].delete(sessionId);
  this["rawSequenceStates"].delete(sessionId);
  if (options.clearCommandInbox) this["inbox"].clearSession(sessionId);
  this["telemetryNormalizer"].clearSession(sessionId);
  this["detachedLiveSessions"].delete(sessionId);
  this["projectionFaultedSessions"].delete(sessionId);
  // detached child 归属清理：自己作为 child 从父表摘除；作为父则连带释放没有 record 的 child。
  this["detachedTerminalAt"].delete(sessionId);
  const parentId = this["detachedChildParent"].get(sessionId);
  if (parentId !== undefined) {
    this["detachedChildParent"].delete(sessionId);
    const siblings = this["detachedChildrenByParent"].get(parentId);
    siblings?.delete(sessionId);
    if (siblings && siblings.size === 0) this["detachedChildrenByParent"].delete(parentId);
  }
  const children = this["detachedChildrenByParent"].get(sessionId);
  if (children) {
    this["detachedChildrenByParent"].delete(sessionId);
    for (const childId of children) {
      this["detachedChildParent"].delete(childId);
      if (this["host"].sessionExists(childId)) continue;
      this["releaseDetachedChild"](childId);
    }
  }
}

export function dispose(this: ConversationV4Gateway): void {
  this["disposed"] = true;
  this["localTtft"].clear();
  for (const sessionId of this["projectionEventCommitWaiters"].keys()) {
    this["rejectProjectionEventWaiters"](
      sessionId,
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.gatewayDisposed",
        "conversation gateway disposed while waiting for projection event commit",
      ),
    );
  }
  clearInterval(this["attachmentPruneTimer"]);
  this["indexFanoutThrottle"].clear();
  this["attachmentUploads"].clear();
  this["binaryReadCache"].clear();
  this["binaryReadCacheBytes"] = 0;
  for (const state of this["flushStates"].values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  this["flushStates"].clear();
  this["publishers"].clear();
  this["hydratedSessions"].clear();
  for (const buffer of this["hydrationBuffers"].values()) buffer.cancelled = true;
  this["hydrationBuffers"].clear();
  this["hydrationInFlight"].clear();
  this["readyFlights"].clear();
  this["rawSequenceStates"].clear();
  this["telemetryEventIds"].clear();
  this["detachedLiveSessions"].clear();
  this["detachedChildParent"].clear();
  this["detachedChildrenByParent"].clear();
  this["detachedTerminalAt"].clear();
  this["projectionFaultedSessions"].clear();
  this["coldResume"].clear();
  this["indexPublishers"].dispose();
  this["configPublishers"].clear();
  this["pausedConnections"].clear();
}

export function flushNow(
  this: ConversationV4Gateway,
  subscriptionId: string,
): ConversationTopicFrame | null {
  const match = [...this["flushStates"].entries()].find(
    ([, state]) => state.subscriptionId === subscriptionId,
  );
  const state = match?.[1];
  if (!state) return null;
  if (this["pausedConnections"].has(state.connectionId)) return null;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const publisher = this["publishers"].get(state.sessionId);
  if (!publisher) return null;
  const reservation = publisher.reserveFlush(state.subscriptionId);
  if (!reservation || !reservation.commit()) return null;
  return reservation.frame;
}

export function ensurePublisher(
  this: ConversationV4Gateway,
  sessionId: string,
): ConversationTopicPublisher {
  let publisher = this["publishers"].get(sessionId);
  if (!publisher) {
    publisher = new ConversationTopicPublisher(sessionId, this["createLogEpoch"](sessionId), {
      now: this["now"],
    });
    this["publishers"].set(sessionId, publisher);
    // config 种子：创建即注入 runtime 真值（不产 delta / 不 bump revision）。
    this["seedPublisherConfig"](sessionId, publisher);
  }
  return publisher;
}

export function seedPublisherConfig(
  this: ConversationV4Gateway,
  sessionId: string,
  publisher: ConversationTopicPublisher,
): void {
  const getSeed = this["host"].getSessionConfigSeed;
  if (!getSeed) return;
  try {
    const seed = getSeed.call(this["host"], sessionId);
    if (seed) publisher.seedConfig(seed);
  } catch (error) {
    this["host"].onError?.("v4.configSeed", error);
  }
}

export function ensureColdReadyPublisher(
  this: ConversationV4Gateway,
  sessionId: string,
  resumeThoughtLevel?: string,
  workspace?: ZCodeWorkspaceRef,
): Promise<ConversationTopicPublisher> {
  const existingFlight = this["readyFlights"].get(sessionId);
  if (existingFlight) return existingFlight;
  // 先登记同一个 READY，再开始所有耗时工作。
  const operation = Promise.resolve().then(async () => {
    const persistedMessages = await this["coldResume"].ensureResumed(
      sessionId,
      resumeThoughtLevel,
      workspace,
    );
    return this["hydratePublisher"](sessionId, persistedMessages);
  });
  this["readyFlights"].set(sessionId, operation);
  // 成功和失败都由同一清理函数释放；不创建会重复传播 rejection 的派生 promise。
  const clear = () => {
    if (this["readyFlights"].get(sessionId) === operation) this["readyFlights"].delete(sessionId);
  };
  void operation.then(clear, clear);
  return operation;
}
