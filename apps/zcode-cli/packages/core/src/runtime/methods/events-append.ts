// Modified by ZCode Feiyu.
import type { SessionEvent, TraceContext } from "../deps.js";
import { SessionEventType, createSessionEvent, traceContextToLogContext } from "../deps.js";

import type { AgentRuntimeInternal } from "../internal.js";
import { publishRuntimeProactiveEvent, runtimeProactiveCause } from "../proactive-causality.js";

import { recordToolUsageFromEvent } from "./usage-observability.js";
import { persistDurableSessionEvent } from "./events-durable.js";

export const SESSION_EVENT_APPEND_SUMMARY_FLUSH_COUNT = 100;

export const SUMMARY_SESSION_EVENT_TYPES = new Set<SessionEventType>([
  SessionEventType.ModelStreaming,
  SessionEventType.ModelNetworkStatus,
  SessionEventType.StreamingToolLedgerUpdated,
  SessionEventType.ToolCallProgress,
]);

// 生产环境只记录会改变 Turn/Session 生命周期的低频事件；stream/progress 仍由
// 现有 debug 聚合日志覆盖，避免诊断日志和消息流同频刷盘。
export const LIFECYCLE_SESSION_EVENT_TYPES = new Set<SessionEventType>([
  SessionEventType.SessionTitleUpdated,
  SessionEventType.TurnStarted,
  SessionEventType.ModelRequest,
  SessionEventType.ModelComplete,
  SessionEventType.TurnComplete,
  SessionEventType.TurnError,
]);

export interface SessionEventAppendAggregate {
  eventCount: number;
  eventType: SessionEventType;
  firstEventId: string;
  firstSessionEventSequenceNumber: number;
  lastEventId: string;
  lastSessionEventSequenceNumber: number;
  payloadBytes: number;
  payloadKinds: Record<string, number>;
}

export const sessionEventAppendAggregates = new WeakMap<
  AgentRuntimeInternal,
  Map<string, SessionEventAppendAggregate>
>();

export function createEvent(
  this: AgentRuntimeInternal,
  type: SessionEventType,
  payload: unknown,
  traceContext: TraceContext,
): SessionEvent {
  return createSessionEvent(type, this.sessionId, payload, {
    turnId: traceContext.turnId,
    traceId: traceContext.traceId,
  });
}

export async function appendEvent(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  // live sink 以前拿到的是 createSessionEvent 默认的 sequenceNumber=0，
  // 而 replay/read 路径拿到的是 eventStore 补号后的事件，导致同一 session 有两套顺序事实。
  // 这里只发布已落库事件，让 live、replay、snapshot 的 eventSeq 全部来自同一个 event store。
  const shouldLogLifecycle = LIFECYCLE_SESSION_EVENT_TYPES.has(event.type);
  const startedAt = Date.now();
  if (shouldLogLifecycle) {
    this.logger?.info("Session event persistence started", {
      ...traceContextToLogContext(traceContext),
      event: "session.event.persistence.started",
      module: "core.runtime",
      sessionEventType: event.type,
      status: "started",
    });
  }

  let phase = "event_store.append";
  try {
    // 终态落库前冻结本轮已消费来源；重放或迟到发布不得读取另一个 active turn 的上下文。
    if (
      (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) &&
      this.activeTurn?.turnId === event.turnId
    ) {
      const causalContext = runtimeProactiveCause(this);
      if (causalContext)
        event = { ...event, payload: { ...(event.payload as object), causalContext } };
    }
    // 先原子确认源事实与触发，再让内存 eventStore/snapshot 看见生命周期；否则并发读也可能早于持久确认。
    phase = "session_event.publish_proactive";
    await publishRuntimeProactiveEvent(this, event);
    phase = "event_store.append";
    const storedEvent = await this.eventStore.append(event);
    phase = "session_event.persist_durable";
    await persistDurableSessionEvent.call(this, storedEvent, traceContext);
    phase = "session_event.record_usage";
    await recordToolUsageFromEvent(this, storedEvent, traceContext);
    phase = "session_event.notify_sinks";
    await this.notifyEventSinks(storedEvent, traceContext);
    if (shouldLogLifecycle) {
      this.logger?.info("Session event persistence completed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        event: "session.event.persistence.completed",
        module: "core.runtime",
        sessionEventSequenceNumber: storedEvent.sequenceNumber,
        sessionEventType: storedEvent.type,
        status: "completed",
      });
    }
    if (recordSessionEventAppendAggregate.call(this, storedEvent, traceContext)) {
      return;
    }
    flushSessionEventAppendAggregates.call(this, traceContext, "low_frequency_event");
    this.logger?.debug("Session event appended", {
      ...traceContextToLogContext(traceContext),
      event: "event_store.appended",
      module: "core.runtime",
      sessionEventSequenceNumber: storedEvent.sequenceNumber,
      sessionEventType: storedEvent.type,
    });
  } catch (error) {
    if (shouldLogLifecycle) {
      this.logger?.warn("Session event persistence failed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session.event.persistence.failed",
        module: "core.runtime",
        phase,
        sessionEventType: event.type,
        status: "failed",
      });
    }
    throw error;
  }
}

export function recordSessionEventAppendAggregate(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): boolean {
  if (!SUMMARY_SESSION_EVENT_TYPES.has(event.type)) {
    return false;
  }

  const aggregateKey = `${traceContext.turnId ?? "session"}:${event.type}`;
  const aggregateMap = getSessionEventAppendAggregateMap(this);
  const payloadKind = getPayloadKind(event.payload);
  const existing = aggregateMap.get(aggregateKey);
  if (existing) {
    existing.eventCount += 1;
    existing.lastEventId = String(event.id);
    existing.lastSessionEventSequenceNumber = event.sequenceNumber;
    existing.payloadBytes += measureJsonBytes(event.payload);
    existing.payloadKinds[payloadKind] = (existing.payloadKinds[payloadKind] ?? 0) + 1;
    if (existing.eventCount >= SESSION_EVENT_APPEND_SUMMARY_FLUSH_COUNT) {
      flushSessionEventAppendAggregate.call(
        this,
        aggregateKey,
        existing,
        traceContext,
        "count_threshold",
      );
    }
    return true;
  }

  aggregateMap.set(aggregateKey, {
    eventCount: 1,
    eventType: event.type,
    firstEventId: String(event.id),
    firstSessionEventSequenceNumber: event.sequenceNumber,
    lastEventId: String(event.id),
    lastSessionEventSequenceNumber: event.sequenceNumber,
    payloadBytes: measureJsonBytes(event.payload),
    payloadKinds: { [payloadKind]: 1 },
  });
  return true;
}

export function flushSessionEventAppendAggregates(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  reason: "count_threshold" | "low_frequency_event",
): void {
  const aggregateMap = sessionEventAppendAggregates.get(this);
  if (!aggregateMap || aggregateMap.size === 0) {
    return;
  }
  for (const [aggregateKey, aggregate] of aggregateMap) {
    flushSessionEventAppendAggregate.call(this, aggregateKey, aggregate, traceContext, reason);
  }
}

export function flushSessionEventAppendAggregate(
  this: AgentRuntimeInternal,
  aggregateKey: string,
  aggregate: SessionEventAppendAggregate,
  traceContext: TraceContext,
  reason: "count_threshold" | "low_frequency_event",
): void {
  const aggregateMap = sessionEventAppendAggregates.get(this);
  aggregateMap?.delete(aggregateKey);
  // 日志治理原因：model streaming / progress 类事件与 token 流同频，
  // 逐条写默认日志会把 eventStore 索引复制成巨量 daily log；这里保留 seq 范围和 kind 分布用于定位。
  this.logger?.debug("Session event append summary", {
    ...traceContextToLogContext(traceContext),
    event: "event_store.appended.summary",
    eventCount: aggregate.eventCount,
    firstEventId: aggregate.firstEventId,
    firstSessionEventSequenceNumber: aggregate.firstSessionEventSequenceNumber,
    flushReason: reason,
    lastEventId: aggregate.lastEventId,
    lastSessionEventSequenceNumber: aggregate.lastSessionEventSequenceNumber,
    module: "core.runtime",
    payloadBytes: aggregate.payloadBytes,
    payloadKinds: aggregate.payloadKinds,
    sessionEventType: aggregate.eventType,
  });
}

export function getSessionEventAppendAggregateMap(
  runtime: AgentRuntimeInternal,
): Map<string, SessionEventAppendAggregate> {
  let aggregateMap = sessionEventAppendAggregates.get(runtime);
  if (!aggregateMap) {
    aggregateMap = new Map();
    sessionEventAppendAggregates.set(runtime, aggregateMap);
  }
  return aggregateMap;
}

export function getPayloadKind(payload: unknown): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const kind = (payload as Record<string, unknown>).kind;
    if (typeof kind === "string" && kind.length > 0) {
      return kind;
    }
  }
  return "<missing>";
}

export function measureJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return 0;
  }
}

export async function notifyEventSinks(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  for (const sink of this.eventSinks) {
    try {
      await sink.onSessionEvent(event);
    } catch (error) {
      this.logger?.warn("Session event sink failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_event_sink.failed",
        module: "core.runtime",
        sessionEventType: event.type,
        status: "failed",
      });
    }
  }
}
