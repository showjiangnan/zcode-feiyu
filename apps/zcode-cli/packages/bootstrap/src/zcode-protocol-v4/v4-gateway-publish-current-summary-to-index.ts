// Modified by ZCode Feiyu.
import type { V4SubscribeDispatchResult } from "./v4-gateway-conversation-v4-gateway-options.js";
import type {
  SessionsIndexTopicFrame,
  WorkspaceConfigTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import {
  v4ConversationSubscribeParamsSchema,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionsIndexPublisher } from "./sessions-index-publisher.js";
import type { ConversationV4Gateway } from "./v4-gateway.js";

export function publishCurrentSummaryToIndex(this: ConversationV4Gateway, sessionId: string): void {
  // 这一次发布带的就是窗内合并后的当前摘要：待发的 trailing 到此被满足，不重复发帧。
  this["indexFanoutThrottle"].notePublished(sessionId);
  const getWorkspaceId = this["host"].getSessionWorkspaceId;
  if (!getWorkspaceId) return;
  try {
    const workspaceId = getWorkspaceId.call(this["host"], sessionId);
    if (!workspaceId) return;
    if (this["host"].isDraftSession?.(sessionId)) return;
    const indexPublisher = this["indexPublishers"].get(workspaceId);
    if (!indexPublisher) return;
    const conversationPublisher = this["publishers"].get(sessionId);
    if (!conversationPublisher) return;
    const changed = indexPublisher.ingestConversation(
      conversationPublisher.getSnapshot(),
      this["resolveIndexMeta"](sessionId),
    );
    if (changed) this["flushIndex"](workspaceId);
  } catch (error) {
    this["host"].onError?.("v4.sessionsIndex.ingest", error);
  }
}

export function resolveIndexMeta(
  this: ConversationV4Gateway,
  sessionId: string,
): {
  createdAt: number;
  lastActivityAt: number;
  parentSessionId?: string;
} {
  const meta = this["host"].getSessionIndexMeta?.(sessionId);
  return {
    createdAt: meta?.createdAt ?? 0,
    lastActivityAt: meta?.lastActivityAt ?? this["now"](),
    ...(meta?.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
  };
}

export function flushIndex(
  this: ConversationV4Gateway,
  workspaceId: string,
  onlyConnectionId?: string,
): void {
  const publisher = this["indexPublishers"].get(workspaceId);
  if (!publisher) return;
  for (const subscriptionId of publisher.subscriptionIds()) {
    const connectionId = publisher.connectionIdForSubscription(subscriptionId);
    if (
      connectionId === null ||
      this["pausedConnections"].has(connectionId) ||
      (onlyConnectionId !== undefined && connectionId !== onlyConnectionId)
    ) {
      continue;
    }
    const reservation = publisher.reserveFlush(subscriptionId);
    if (!reservation) continue;
    try {
      this["emitReservation"](reservation);
    } catch (error) {
      this["host"].onError?.("v4.sessionsIndex.emit", error);
    }
  }
}

export async function subscribeSessionsIndex(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
  const dispatch = await this.subscribeSessionsIndexReserved(rawParams);
  dispatch.commit();
  return dispatch;
}

export async function subscribeSessionsIndexReserved(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
  const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
  const workspaceId = parseSessionsIndexTopic(params.topic);
  if (workspaceId === null) {
    throw new Error(`Not a sessions-index topic: ${params.topic}`);
  }
  const publisher = await this["ensureIndexPublisher"](workspaceId, params.legacyTaskIds);
  // ensure 内部可能跨异步 store/claim；dispose 发生在 await 返回前时禁止继续登记订阅。
  this["indexPublishers"].ensureActive();
  const result = publisher.subscribeReserved(params.connectionId, params.base);
  try {
    return this["subscribeDispatch"](
      {
        subscriptionId: result.subscriptionId,
        mode: result.mode,
        logEpoch: publisher.logEpoch,
      },
      result.reservation,
      () => this["flushIndex"](workspaceId),
    );
  } catch (error) {
    // initial logical frame 在 physical encode 阶段即可因 16MiB 上限失败；
    // 已登记订阅/in-flight reservation 后失败必须 rollback，否则会留下永远无法退订的幽灵 owner。
    result.rollback();
    throw error;
  }
}

export async function ensureIndexPublisher(
  this: ConversationV4Gateway,
  workspaceId: string,
  legacyTaskIds?: readonly string[],
): Promise<SessionsIndexPublisher> {
  const existing = this["indexPublishers"].get(workspaceId);
  const shouldRefreshLegacy =
    Boolean(legacyTaskIds?.length) && Boolean(this["host"].refreshLegacySessionSummaries);
  if (existing && !shouldRefreshLegacy) return existing;
  return this["indexPublishers"].runExclusive(workspaceId, () =>
    this["ensureIndexPublisherExclusive"](workspaceId, legacyTaskIds),
  );
}

export async function ensureIndexPublisherExclusive(
  this: ConversationV4Gateway,
  workspaceId: string,
  legacyTaskIds?: readonly string[],
): Promise<SessionsIndexPublisher> {
  const refreshed =
    legacyTaskIds && legacyTaskIds.length > 0
      ? ((await this["host"].refreshLegacySessionSummaries?.(workspaceId, legacyTaskIds)) ?? null)
      : null;
  const existing = this["indexPublishers"].get(workspaceId);
  if (existing) {
    // claim 不能绑定到首次构造：空种子一旦进 Map 就永久挡住重试。
    // 重读只补缺失项，避免冷存储默认态覆盖已有 live projection。
    if (refreshed && existing.mergeMissingStoredSummaries(refreshed)) {
      this["flushIndex"](workspaceId);
    }
    return existing;
  }
  const publisher = new SessionsIndexPublisher(
    workspaceId,
    this["createLogEpoch"](`sessions-index/${workspaceId}`),
    this["now"],
  );
  // 种子 1：store 里全部会话的轻量摘要（未加载的靠它进列表）。
  const stored = refreshed ?? (await this["host"].getStoredSessionSummaries?.(workspaceId)) ?? [];
  for (const summary of stored) publisher.seed(summary);
  // 种子 2：已加载会话用 live 投影覆盖（更准的 phase/preview/backgroundWork）。
  const liveIds = this["host"].listWorkspaceSessionIds?.(workspaceId) ?? [
    ...this["publishers"].keys(),
  ];
  for (const sessionId of liveIds) {
    const conversationPublisher = this["publishers"].get(sessionId);
    if (!conversationPublisher) continue;
    // draft（deferred 未发首条）不进冷启动种子，与 fanOutToIndex 的过滤一致。
    if (this["host"].isDraftSession?.(sessionId)) continue;
    publisher.ingestConversation(
      conversationPublisher.getSnapshot(),
      this["resolveIndexMeta"](sessionId),
    );
  }
  this["indexPublishers"].set(workspaceId, publisher);
  return publisher;
}

export async function subscribeWorkspaceConfig(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
  const dispatch = await this.subscribeWorkspaceConfigReserved(rawParams);
  dispatch.commit();
  return dispatch;
}

export async function subscribeWorkspaceConfigReserved(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
  const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
  const workspaceId = parseWorkspaceConfigTopic(params.topic);
  if (workspaceId === null) {
    throw new Error(`Not a workspace-config topic: ${params.topic}`);
  }
  const publisher = await this["ensureConfigPublisher"](workspaceId);
  const result = publisher.subscribeReserved(params.connectionId, params.base);
  try {
    return this["subscribeDispatch"](
      {
        subscriptionId: result.subscriptionId,
        mode: result.mode,
        logEpoch: publisher.logEpoch,
      },
      result.reservation,
      () => this["flushConfig"](workspaceId),
    );
  } catch (error) {
    // 与 sessions-index 同一原子边界：encode 失败 = subscribe 未 admission。
    result.rollback();
    throw error;
  }
}
