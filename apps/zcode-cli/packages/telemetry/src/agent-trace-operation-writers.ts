// Modified by ZCode Feiyu.
import { type Attributes, type Context, type Span } from "@opentelemetry/api";
import type {
  AgentTelemetryCancellationReason,
  AgentTelemetryErrorCategory,
  CommandExecutionSpanWriter,
  ContextCompactionSpanWriter,
  DetachedOperationSpanWriter,
} from "@zcode/contracts/telemetry";
import { type AgentTelemetryMetricRecorder } from "./agent-metrics.js";
import { classifyErrorCategory, lifecycleKeys } from "./agent-trace-attributes.js";
import {
  compactAttributes,
  finiteNonNegative,
  integer,
  isAbortLike,
  safeEnum,
  safeIdentifier,
  type ActiveWriterContext,
  type WriterHealth,
  type WriterTerminalObservation,
} from "./agent-trace-support.js";
import { TrackedWriter } from "./agent-trace-types.js";
import { TrackedBaseWriter } from "./agent-trace-writer-base.js";
import { commandCompatibilityAttributes } from "./compatibility-adapters.js";

export class CommandWriter extends TrackedBaseWriter implements CommandExecutionSpanWriter {
  private firstOutput = false;
  private firstOutputMs: number | undefined;

  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    private readonly metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("command_execution"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  markFirstOutput(): void {
    if (this.firstOutput) return;
    this.firstOutput = true;
    const elapsed = this.elapsedMs();
    this.firstOutputMs = elapsed;
    this.setAttribute("zcode.command_execution.first_output_ms", elapsed);
    this.addEvent("first_output");
  }

  markTerminationRequested(reason: "cancelled" | "timeout" | "shutdown"): void {
    this.addEvent("termination_requested", { reason });
  }

  setExitCode(exitCode: number): void {
    const normalized = integer(exitCode);
    this.setAttribute("zcode.command_execution.exit_code", normalized);
    this.setAttributes(commandCompatibilityAttributes({ exitCode: normalized }));
  }

  setSignal(signal: string): void {
    const normalized = safeIdentifier(signal);
    this.setAttribute("zcode.command_execution.signal", normalized);
    this.setAttributes(commandCompatibilityAttributes({ signal: normalized }));
  }

  setOutputBytes(bytes: number): void {
    this.setAttribute("zcode.command_execution.output_bytes", finiteNonNegative(bytes));
  }

  setTimedOut(timedOut: boolean): void {
    this.setAttribute("zcode.command_execution.timed_out", timedOut);
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishFailed(
    stage: "prepare" | "spawn" | "execute" | "timeout" | "collect_output" | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  finishBackgrounded(): void {
    this.finishDomainOutcomeIfOpen("backgrounded");
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) {
      this.finishCancelledIfOpen("abort_signal");
    } else {
      const category = classifyErrorCategory(error);
      this.finishFailedIfOpen("unhandled", category, error);
    }
  }

  protected override recordTerminalDetailMetrics(
    outcome: string,
    observation: WriterTerminalObservation,
  ): void {
    if (this.firstOutputMs === undefined) return;
    this.metrics.recordCommandFirstOutput(
      this.firstOutputMs,
      compactAttributes({
        ...this.metricLabels,
        error_category: observation.errorCategory,
        outcome,
      }),
    );
  }
}

export class CompactionWriter extends TrackedBaseWriter implements ContextCompactionSpanWriter {
  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("context_compaction"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  setInputTokens(tokens: number): void {
    this.setAttribute("zcode.context_compaction.input_tokens", finiteNonNegative(tokens));
  }

  setOutputTokens(tokens: number): void {
    this.setAttribute("zcode.context_compaction.output_tokens", finiteNonNegative(tokens));
  }

  markFallbackSelected(reason: string): void {
    this.addEvent("fallback_selected", { reason: safeEnum(reason) });
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishDiscarded(): void {
    this.finishDomainOutcomeIfOpen("discarded");
  }

  finishFailed(
    stage: "prepare" | "model" | "parse" | "commit" | "fallback" | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) this.finishCancelledIfOpen("abort_signal");
    else this.finishFailedIfOpen("unhandled", classifyErrorCategory(error), error);
  }
}

export class DetachedWriter extends TrackedBaseWriter implements DetachedOperationSpanWriter {
  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("detached_operation"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  setResultType(resultType: "text" | "boolean" | "metadata" | "other"): void {
    this.setAttribute("zcode.detached_operation.result_type", resultType);
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishFailed(
    stage: "schedule" | "execute" | "commit" | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) this.finishCancelledIfOpen("abort_signal");
    else this.finishFailedIfOpen("unhandled", classifyErrorCategory(error), error);
  }
}
