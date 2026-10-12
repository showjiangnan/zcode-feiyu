// Modified by ZCode Feiyu.
import { type Attributes, type Context, type Span } from "@opentelemetry/api";
import type { AgentTelemetryAbandonReason } from "@zcode/contracts/telemetry";
import { type AgentMetricSpanName, type AgentTelemetryMetricRecorder } from "./agent-metrics.js";
import { terminalMetricLabels } from "./agent-trace-attributes.js";
import {
  BaseSpanWriter,
  type ActiveWriterContext,
  type WriterHealth,
  type WriterLifecycleKeys,
  type WriterTerminalObservation,
} from "./agent-trace-support.js";
import { TrackedWriter } from "./agent-trace-types.js";

export abstract class TrackedBaseWriter extends BaseSpanWriter {
  protected readonly metricLabels: Attributes;

  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    lifecycle: WriterLifecycleKeys,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    const terminalTarget: { writer?: TrackedBaseWriter } = {};
    super(span, parentContext, metadata, lifecycle, health, (outcome, durationMs, observation) => {
      const writer = terminalTarget.writer;
      if (writer) {
        // 终态 Metric 从 Writer 已记录的实时事实投影，覆盖显式 finish、业务异常、
        // missing_terminal 和进程回收；不能只埋在各 finishXxx 分支里留下缺口。
        writer.safe(() => onRemoved(writer));
        writer.safe(() => writer.recordTerminalDetailMetrics(outcome, observation));
        writer.safe(() =>
          metrics.recordSpanTerminal(
            metadata.spanName as AgentMetricSpanName,
            outcome,
            durationMs,
            terminalMetricLabels(metricLabels, observation),
            observation.abandonReason,
          ),
        );
      }
    });
    terminalTarget.writer = this;
    this.metricLabels = metricLabels;
  }

  abandon(reason: AgentTelemetryAbandonReason): void {
    this.finishAbandonedIfOpen(reason);
  }

  protected recordTerminalDetailMetrics(
    _outcome: string,
    _observation: WriterTerminalObservation,
  ): void {}
}
