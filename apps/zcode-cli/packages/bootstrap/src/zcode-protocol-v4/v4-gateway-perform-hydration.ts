// Modified by ZCode Feiyu.
import type {
  HydrationBuffer,
  RawSequenceState,
} from "./v4-gateway-conversation-v4-gateway-options.js";
import type { MessageWithParts, SessionEvent } from "@zcode/contracts";
import {
  ConversationTopicPublisher,
  ProjectionPayloadTooLargeError,
} from "./conversation-topic-publisher.js";
import type { PersistedEventsLoadResult } from "./v4-gateway-to-runtime-turn-id.js";
import { ProjectionEventCommitWaitError } from "./v4-gateway-conversation-v4-gateway-options.js";
import type { ConversationV4Gateway } from "./v4-gateway.js";

export async function performHydration(
  this: ConversationV4Gateway,
  sessionId: string,
  buffer: HydrationBuffer,
  persistedMessages?: MessageWithParts[],
  forceRebuild = false,
): Promise<ConversationTopicPublisher> {
  const existingAtStart = this["publishers"].get(sessionId);
  const liveSessionAtStart = this["host"].sessionExists(sessionId);
  const hydrationStartedAt = performance.now();
  this["host"].onDebug?.(
    `v4 hydrate started session=${sessionId} liveSessionAtStart=${String(liveSessionAtStart)} ` +
      `existingPublisherAtStart=${String(existingAtStart !== undefined)} ` +
      `persistedMessages=${String(persistedMessages?.length ?? 0)}`,
  );
  const loaded: PersistedEventsLoadResult = this["host"].loadPersistedEvents
    ? await this["host"].loadPersistedEvents(sessionId, persistedMessages).catch((error) => {
        this["host"].onError?.("v4.hydrate", error, {
          durationMs: Math.max(0, Math.round(performance.now() - hydrationStartedAt)),
          existingPublisherAtStart: existingAtStart !== undefined,
          liveSessionAtStart,
          phase: "loadPersistedEvents",
          persistedMessages: persistedMessages?.length ?? 0,
          sessionId,
        });
        return { events: [] as SessionEvent[], synthesized: false, sourceEventSeq: 0 };
      })
    : { events: [] as SessionEvent[], synthesized: false, sourceEventSeq: 0 };
  this["host"].onDebug?.(
    `v4 hydrate loaded session=${sessionId} events=${loaded.events.length} ` +
      `synthesized=${String(loaded.synthesized)} sourceEventSeq=${String(loaded.sourceEventSeq ?? 0)} ` +
      `durationMs=${String(Math.max(0, Math.round(performance.now() - hydrationStartedAt)))}`,
  );
  if (this["disposed"] || buffer.cancelled) {
    throw new Error(`v4 hydration cancelled for session ${sessionId}`);
  }
  // assistant 守恒：拒收过正文流的 publisher 不可信——它建立于
  // TurnStarted 之后，缺段无法用 append-only 重放补进中间位置，只能整体重建。
  const latestPublisher = this["publishers"].get(sessionId);
  const existingDroppedContent =
    latestPublisher !== undefined && latestPublisher.getDroppedContentStreamEventCount() > 0;
  // 事件日志完整（synthesized=false）且已有健康 live publisher（流式）→ 保留，不重放。
  if (
    existingAtStart &&
    latestPublisher === existingAtStart &&
    !loaded.synthesized &&
    !forceRebuild &&
    !existingDroppedContent
  ) {
    // 创建时种子可能落空（record 尚未入册），首次订阅补一次（幂等、事件优先）。
    this["hydrationBuffers"].delete(sessionId);
    this["seedPublisherConfig"](sessionId, latestPublisher);
    if (loaded.sharedContextImport) {
      latestPublisher.seedSharedContextImport(loaded.sharedContextImport);
    }
    await this["seedPublisherUsage"](
      sessionId,
      latestPublisher,
      persistedMessages,
      loaded.usageSeed,
    );
    this["hydratedSessions"].add(sessionId);
    this["publishCurrentSummaryToIndex"](sessionId);
    return latestPublisher;
  }
  // 只记住 await 之前的 existing 引用是不够的：load 等待期间 raw event
  // 会继续推进这个 publisher，synthesized 返回后却把它整体删除，queue/stream 随之
  // 消失。重建以 sourceEventSeq 为 raw snapshot 边界，并把等待窗口内事件补回。
  const publisher = latestPublisher ?? existingAtStart ?? this["ensurePublisher"](sessionId);
  this["rejectProjectionEventWaiters"](
    sessionId,
    new ProjectionEventCommitWaitError(
      "fault.projectionEventCommit.rehydrated",
      `conversation projection rehydrated while waiting for event commit: ${sessionId}`,
    ),
  );
  publisher.rehydrate(loaded.events, {
    // 恢复时 transcript/event store 可能仍含运行期已拒绝的超大正文。不能让同一事实
    // 在 CLI 重启后再次把 subscribe 卡死；跳过该不可传输 projection event，继续归约
    // 后续持久 TurnError/TurnComplete，使冷快照停在最后一个可恢复边界。
    onPayloadTooLarge: (error) =>
      this["host"].onError?.("v4.hydrate.payloadTooLarge", error, {
        phase: "publisher.rehydrate",
        sessionId,
      }),
  });
  if (loaded.sharedContextImport) {
    publisher.seedSharedContextImport(loaded.sharedContextImport);
  }
  if (loaded.subagentsSeed) publisher.seedSubagents(loaded.subagentsSeed);
  // 同次恢复的种子先应用，再补 live buffer；较新的使用量和选模事件始终获胜。
  if (loaded.usageSeed) publisher.seedUsage(loaded.usageSeed);
  const sourceEventSeq = Math.max(
    0,
    loaded.sourceEventSeq ??
      (loaded.synthesized
        ? 0
        : loaded.events.reduce((maximum, event) => Math.max(maximum, event.sequenceNumber), 0)),
  );
  const previousSequenceState = this["rawSequenceStates"].get(sessionId);
  const sequenceState: RawSequenceState = {
    sourceEventSeq,
    offset: publisher.getSnapshot().seq - sourceEventSeq,
    lastTransportSeq: publisher.getSnapshot().seq,
    seenEventIds: new Set(loaded.events.map((event) => String(event.id))),
    appliedEventIds: new Set(loaded.events.map((event) => String(event.id))),
    failedEventById: new Map(previousSequenceState?.failedEventById),
    pendingByRawSeq: new Map(),
    recentRawEventsById: new Map(),
  };
  this["rawSequenceStates"].set(sessionId, sequenceState);
  // 持久读取的 sourceEventSeq 是 load 开始时的水位；hydration buffer
  // 只能记录 load 开始后的事件。若 seq=N 已在 buffer 创建前进入 live publisher，而
  // load 只读到 N-1 时，rehydrate 后不能仅重放 N+1：raw reorder 会永久等待已经被
  // 丢掉的 N，连带让 running Agent 控制行消失。保留与 publisher 相同大小的 raw tail，
  // 与 await 窗口 buffer 合并后从持久边界连续重放。
  const replayByEventId = new Map<string, SessionEvent>();
  for (const rawEvent of previousSequenceState?.recentRawEventsById.values() ?? []) {
    if (rawEvent.sequenceNumber <= 0 || rawEvent.sequenceNumber > sourceEventSeq) {
      replayByEventId.set(String(rawEvent.id), rawEvent);
    }
  }
  for (const rawEvent of buffer.rawEvents) {
    if (rawEvent.sequenceNumber <= 0 || rawEvent.sequenceNumber > sourceEventSeq) {
      replayByEventId.set(String(rawEvent.id), rawEvent);
    }
  }
  const replayEvents = [...replayByEventId.values()].sort((left, right) => {
    if (left.sequenceNumber > 0 && right.sequenceNumber > 0) {
      return left.sequenceNumber - right.sequenceNumber;
    }
    if (left.sequenceNumber > 0) return -1;
    if (right.sequenceNumber > 0) return 1;
    return 0;
  });
  for (const rawEvent of replayEvents) {
    for (const normalized of this["normalizeRuntimeEventSequence"](sessionId, rawEvent)) {
      try {
        publisher.ingest(normalized);
        this["resolveProjectionEventCommit"](sessionId, String(normalized.id));
      } catch (error) {
        this["rejectProjectionEventCommit"](
          sessionId,
          String(normalized.id),
          new ProjectionEventCommitWaitError(
            "fault.projectionEventCommit.applyFailed",
            `projection failed to apply hydrated event ${String(normalized.id)}`,
            { cause: error },
          ),
        );
        if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
        this["host"].onError?.("v4.hydrate.payloadTooLarge", error, {
          phase: "replayBufferedEvents",
          sessionId,
        });
      }
    }
  }
  // publisher 已替换且 buffer 已同步补齐；在 usage seed 的异步等待窗口内，新 raw
  // event 直接走上面的 per-session sequence state 进入新 publisher，不再需要二次 replay。
  if (this["hydrationBuffers"].get(sessionId) === buffer) {
    this["hydrationBuffers"].delete(sessionId);
  }
  // 冷恢复种子（重放之后）：resume 已把历史会话的上次选型写回 runtime
  // （reconcileResumedRuntimeSettings），而合成/持久化事件里可能没有 ModelSelected——
  // 种子只填事件未触碰的字段，日志有值时以日志为准（冷恢复口径）。
  this["seedPublisherConfig"](sessionId, publisher);
  if (loaded.usageSeed === undefined) {
    await this["seedPublisherUsage"](sessionId, publisher, persistedMessages);
  }
  for (const [routeKey, state] of this["flushStates"]) {
    if (state.sessionId !== sessionId) continue;
    if (!publisher.hasSubscription(state.subscriptionId, state.connectionId)) continue;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (this["pausedConnections"].has(state.connectionId)) continue;
    const reservation = publisher.reserveFlush(state.subscriptionId);
    if (!reservation) continue;
    try {
      this["emitReservation"](reservation);
    } catch (error) {
      this["host"].onError?.("v4.hydrate.subscriptionResync", error, {
        phase: "subscriptionResync",
        sessionId,
      });
      this["scheduleFlush"](routeKey, state, publisher);
    }
  }
  this["hydratedSessions"].add(sessionId);
  this["publishCurrentSummaryToIndex"](sessionId);
  return publisher;
}
