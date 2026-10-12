// Modified by ZCode Feiyu.
import { context, SpanKind, trace, type Span, type Tracer } from "@opentelemetry/api";
import type { TelemetryIdentitySnapshot } from "@zcode/contracts/telemetry";
import {
  NOOP_AGENT_TELEMETRY_METRICS,
  type AgentMetricSpanName,
  type AgentTelemetryMetricRecorder,
} from "./agent-metrics.js";
import { positiveLimit } from "./agent-trace-attributes.js";
import { activeWriterContext, safeId, type WriterHealth } from "./agent-trace-support.js";
import type {
  AgentTraceRuntimeOptions,
  StartWriterOptions,
  TrackedWriter,
} from "./agent-trace-types.js";

// 按职责继承只拆方法；activeWriters 与身份等状态在这个基类实例初始化一次。
export class AgentTraceRuntimeState {
  protected readonly activeWriters = new Set<TrackedWriter>();

  protected capacityWarningActive = false;

  protected identity: TelemetryIdentitySnapshot;

  protected readonly maxActiveWriters: number;

  protected readonly tracer: Tracer;

  protected readonly health: WriterHealth;

  protected readonly metrics: AgentTelemetryMetricRecorder;

  constructor(options: AgentTraceRuntimeOptions) {
    this.tracer = options.tracer;
    this.maxActiveWriters = positiveLimit(options.maxActiveWriters, 5_000);
    this.health = { onWarning: options.onWarning };
    this.metrics = options.metrics ?? NOOP_AGENT_TELEMETRY_METRICS;
    this.identity = options.identity ?? { identityState: "unknown" };
  }

  updateIdentity(snapshot: TelemetryIdentitySnapshot): void {
    this.identity = {
      identityState: snapshot.identityState,
      ...(safeId(snapshot.userSubjectId) ? { userSubjectId: safeId(snapshot.userSubjectId) } : {}),
    };
  }

  captureCausation() {
    const active = activeWriterContext();
    if (!active) return undefined;
    const spanContext = active.span.spanContext();
    if (!trace.isSpanContextValid(spanContext)) return undefined;
    return {
      isRemote: spanContext.isRemote ?? false,
      spanId: spanContext.spanId,
      traceFlags: spanContext.traceFlags,
      traceId: spanContext.traceId,
      ...(spanContext.traceState ? { traceState: spanContext.traceState.serialize() } : {}),
      sessionId: active.correlation?.sessionId,
      turnId: active.correlation?.turnId,
      toolCallId: active.toolCallId,
    };
  }

  abandonSession(sessionId: string): void {
    for (const writer of this.activeWriters) {
      if (writer.state.correlation?.sessionId === sessionId) {
        writer.abandon("session_shutdown");
      }
    }
  }

  abandonProcess(): void {
    for (const writer of this.activeWriters) writer.abandon("process_shutdown");
  }

  protected startSpan(options: StartWriterOptions): Span {
    return this.tracer.startSpan(
      options.spanName,
      {
        attributes: options.attributes,
        kind: options.kind ?? SpanKind.INTERNAL,
        links: options.links,
      },
      options.context ?? context.active(),
    );
  }

  protected track<T extends TrackedWriter>(writer: T): T {
    this.activeWriters.add(writer);
    return writer;
  }

  protected safeCreate<T>(spanName: string, create: () => T, fallback: T): T {
    if (this.activeWriters.size >= this.maxActiveWriters) {
      this.safeMetric(() =>
        this.metrics.recordCreationDrop(spanName as AgentMetricSpanName, "process_capacity"),
      );
      if (!this.capacityWarningActive) {
        this.capacityWarningActive = true;
        try {
          this.health.onWarning?.("Telemetry active writer capacity was reached", {
            activeWriterCount: this.activeWriters.size,
            maxActiveWriters: this.maxActiveWriters,
            spanName,
          });
        } catch {
          // 健康回调同样属于旁路。
        }
      }
      return fallback;
    }
    this.capacityWarningActive = false;
    try {
      return create();
    } catch (error) {
      this.safeMetric(() =>
        this.metrics.recordCreationDrop(spanName as AgentMetricSpanName, "unknown"),
      );
      try {
        this.health.onWarning?.("Telemetry writer creation failed", {
          errorType: error instanceof Error ? error.name : typeof error,
          spanName,
        });
      } catch {
        // 健康回调同样属于旁路。
      }
      return fallback;
    }
  }

  protected safeMetric(record: () => void): void {
    try {
      record();
    } catch (error) {
      try {
        this.health.onWarning?.("Telemetry metric operation failed", {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      } catch {
        // Metric 与健康回调都属于旁路。
      }
    }
  }
}
