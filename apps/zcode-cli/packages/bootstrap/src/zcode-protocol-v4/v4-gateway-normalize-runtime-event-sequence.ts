// Modified by ZCode Feiyu.
import type { SessionEvent, MessageWithParts } from "@zcode/contracts";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { SessionEventType } from "@zcode/contracts";
import type { RawSequenceState, FlushState } from "./v4-gateway-conversation-v4-gateway-options.js";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import type { SessionUsageSeed } from "./product-projection.js";
import type { ConversationV4Gateway } from "./v4-gateway.js";

export function normalizeRuntimeEventSequence(
  this: ConversationV4Gateway,
  sessionId: string,
  event: SessionEvent,
): SessionEvent[] {
  const state = this["getOrCreateRawSequenceState"](sessionId);
  const eventId = String(event.id);
  if (state.seenEventIds.has(eventId)) return [];
  const rawSeq = event.sequenceNumber;
  state.recentRawEventsById.set(eventId, event);
  while (state.recentRawEventsById.size > PROTOCOL_V4_LIMITS.eventRetentionPerSession) {
    const oldestEventId = state.recentRawEventsById.keys().next().value;
    if (oldestEventId === undefined) break;
    state.recentRawEventsById.delete(oldestEventId);
  }
  if (rawSeq <= 0) {
    state.seenEventIds.add(eventId);
    state.lastTransportSeq += 1;
    return [{ ...event, sequenceNumber: state.lastTransportSeq }];
  }
  if (event.type === SessionEventType.SessionResumed) {
    // 旧 runtime 在 unsubscribe/重建窗口时可能遗漏尾部 raw event。新 runtime
    // 延续持久 eventStore 高水位时，SessionResumed 的 raw seq 会大于旧 cursor；
    // 若只处理 seq 回退，resume 和后续 TurnStarted 就会永久等待无法补齐的旧 gap。
    // SessionResumed 是明确 epoch 边界：丢弃边界前的旧 pending，同时保留可能乱序先到的
    // 新 epoch 后续事件，再从 resume 自身连续 drain。
    for (const pendingSeq of state.pendingByRawSeq.keys()) {
      if (pendingSeq <= rawSeq) state.pendingByRawSeq.delete(pendingSeq);
    }
    state.sourceEventSeq = rawSeq - 1;
    state.offset = state.lastTransportSeq - state.sourceEventSeq;
  }
  if (rawSeq <= state.sourceEventSeq) {
    state.seenEventIds.add(eventId);
    this["resolveProjectionEventCommit"](sessionId, eventId);
    return [];
  }
  state.seenEventIds.add(eventId);
  if (!state.pendingByRawSeq.has(rawSeq)) state.pendingByRawSeq.set(rawSeq, event);
  const ready: SessionEvent[] = [];
  // eventStore 先编号，各事件各自 await 持久化后再 notify，
  // 因此 N+1 可以先于 N 到达。高水位过滤会把迟到 N 错判成 duplicate；
  // 必须按 raw seq 暂存，只连续 drain，才能保住 queue/stream 总序。
  for (;;) {
    const nextRawSeq = state.sourceEventSeq + 1;
    const next = state.pendingByRawSeq.get(nextRawSeq);
    if (!next) break;
    state.pendingByRawSeq.delete(nextRawSeq);
    let transportSeq = nextRawSeq + state.offset;
    if (transportSeq <= state.lastTransportSeq) {
      transportSeq = state.lastTransportSeq + 1;
      state.offset = transportSeq - nextRawSeq;
    }
    state.sourceEventSeq = nextRawSeq;
    state.lastTransportSeq = transportSeq;
    // waiter timeout/abort 只清 listener 是不够的，还要终止已在 raw gap 中的
    // event。command 返回 failed 后，缺失 seq 一到仍会把同一 TurnStarted 投影出来。
    // 失败事件仍消费 raw 序号以解除后续事件阻塞，但绝不能再成为 canonical fact。
    if (state.failedEventById.has(String(next.id))) {
      continue;
    }
    ready.push(
      transportSeq === next.sequenceNumber ? next : { ...next, sequenceNumber: transportSeq },
    );
  }
  return ready;
}

export function getOrCreateRawSequenceState(
  this: ConversationV4Gateway,
  sessionId: string,
): RawSequenceState {
  const existing = this["rawSequenceStates"].get(sessionId);
  if (existing) return existing;
  const created: RawSequenceState = {
    sourceEventSeq: 0,
    offset: 0,
    lastTransportSeq: 0,
    seenEventIds: new Set(),
    appliedEventIds: new Set(),
    failedEventById: new Map(),
    pendingByRawSeq: new Map(),
    recentRawEventsById: new Map(),
  };
  this["rawSequenceStates"].set(sessionId, created);
  return created;
}

export function resolveProjectionEventCommit(
  this: ConversationV4Gateway,
  sessionId: string,
  eventId: string,
): void {
  const state = this["getOrCreateRawSequenceState"](sessionId);
  state.failedEventById.delete(eventId);
  state.appliedEventIds.add(eventId);
  const waiters = this["projectionEventCommitWaiters"].get(sessionId)?.get(eventId);
  if (!waiters) return;
  // waiter 结算会解除登记；按本次事件的固定快照通知，避免遍历期间变更集合。
  for (const waiter of Array.from(waiters)) waiter.resolve();
}

export function rejectProjectionEventCommit(
  this: ConversationV4Gateway,
  sessionId: string,
  eventId: string,
  error: Error,
): void {
  const state = this["getOrCreateRawSequenceState"](sessionId);
  state.failedEventById.set(eventId, error);
  const waiters = this["projectionEventCommitWaiters"].get(sessionId)?.get(eventId);
  if (!waiters) return;
  for (const waiter of Array.from(waiters)) waiter.reject(error);
}

export function rejectProjectionEventWaiters(
  this: ConversationV4Gateway,
  sessionId: string,
  error: Error,
): void {
  const byEvent = this["projectionEventCommitWaiters"].get(sessionId);
  if (!byEvent) return;
  for (const waiters of byEvent.values()) {
    for (const waiter of Array.from(waiters)) waiter.reject(error);
  }
  this["projectionEventCommitWaiters"].delete(sessionId);
}

export function hasLiveConversation(this: ConversationV4Gateway, sessionId: string): boolean {
  return this["host"].sessionExists(sessionId) || this["detachedLiveSessions"].has(sessionId);
}

export async function seedPublisherUsage(
  this: ConversationV4Gateway,
  sessionId: string,
  publisher: ConversationTopicPublisher,
  persistedMessages?: MessageWithParts[],
  loadedSeed?: SessionUsageSeed | null,
): Promise<void> {
  if (loadedSeed !== undefined) {
    if (loadedSeed) publisher.seedUsage(loadedSeed);
    return;
  }
  const getSeed = this["host"].getSessionUsageSeed;
  if (!getSeed) return;
  try {
    const seed = await getSeed.call(this["host"], sessionId, persistedMessages);
    if (seed) publisher.seedUsage(seed);
  } catch (error) {
    this["host"].onError?.("v4.usageSeed", error);
  }
}

export function scheduleFlush(
  this: ConversationV4Gateway,
  routeKey: string,
  state: FlushState,
  publisher: ConversationTopicPublisher,
): void {
  if (this["pausedConnections"].has(state.connectionId)) return;
  if (state.timer !== null) return;
  const timer = setTimeout(() => {
    state.timer = null;
    // timer 排队后可能收到 SAT；reserve 前必须二次检查，不能产生竞态帧。
    if (this["pausedConnections"].has(state.connectionId)) return;
    // 惰性清理：订阅已被替换/退订→ 删调度状态，不产帧。
    if (!publisher.hasSubscription(state.subscriptionId, state.connectionId)) {
      this["flushStates"].delete(routeKey);
      return;
    }
    const reservation = publisher.reserveFlush(state.subscriptionId);
    if (!reservation) return;
    try {
      this["emitReservation"](reservation);
    } catch (error) {
      this["host"].onError?.("v4.frame.emit", error);
    }
  }, state.flushWindowMs);
  // CLI 进程退出不被 flush 定时器挂住。
  timer.unref?.();
  state.timer = timer;
}
