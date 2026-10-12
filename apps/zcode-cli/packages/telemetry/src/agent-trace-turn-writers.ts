// Modified by ZCode Feiyu.
import { type Attributes, type Context, type Span } from "@opentelemetry/api";
import type {
  AgentStepSpanWriter,
  AgentTelemetryCancellationReason,
  AgentTelemetryErrorCategory,
  AgentTurnSpanWriter,
  CommandExecutionSpanWriter,
  CommandTraceStart,
  ToolExecutionSpanWriter,
} from "@zcode/contracts/telemetry";
import { type AgentTelemetryMetricRecorder } from "./agent-metrics.js";
import { classifyErrorCategory, lifecycleKeys } from "./agent-trace-attributes.js";
import {
  finiteNonNegative,
  isAbortLike,
  type ActiveWriterContext,
  type WriterHealth,
} from "./agent-trace-support.js";
import { TrackedWriter } from "./agent-trace-types.js";
import { TrackedBaseWriter } from "./agent-trace-writer-base.js";

export class TurnWriter extends TrackedBaseWriter implements AgentTurnSpanWriter {
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
      lifecycleKeys("agent_turn"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  finishCompleted(
    resultType: "assistant_message" | "tool_request" | "no_output" | "other" = "other",
  ): void {
    this.finishCompletedIfOpen(() => this.setAttribute("zcode.agent_turn.result_type", resultType));
  }

  finishFailed(
    stage: "setup" | "agent_loop" | "finalize" | "unhandled",
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

export class StepWriter extends TrackedBaseWriter implements AgentStepSpanWriter {
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
      lifecycleKeys("agent_step"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  finishCompleted(
    terminalReason:
      | "model_completed"
      | "tool_requested"
      | "turn_completed"
      | "compaction_requested",
  ): void {
    this.metricLabels.terminal_reason = terminalReason;
    this.finishCompletedIfOpen(() =>
      this.setAttribute("zcode.agent_step.terminal_reason", terminalReason),
    );
  }

  finishDiscarded(): void {
    this.finishDomainOutcomeIfOpen("discarded");
  }

  finishFailed(
    stage: "prepare" | "model" | "tool" | "commit" | "unhandled",
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

export class ToolWriter extends TrackedBaseWriter implements ToolExecutionSpanWriter {
  private permissionRequested = false;

  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
    private readonly createCommand: (
      input: CommandTraceStart & { parent: ToolWriter },
    ) => CommandExecutionSpanWriter,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("tool_execution"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  markPermissionRequested(): void {
    if (this.permissionRequested) return;
    this.permissionRequested = true;
    this.addEvent("permission_requested");
  }

  setPermissionDecision(decision: "granted" | "denied" | "not_required"): void {
    this.setAttribute("zcode.tool_execution.permission_decision", decision);
    if (this.permissionRequested && decision !== "not_required") {
      this.addEvent("permission_decided", { decision });
    }
  }

  setOutputBytes(bytes: number): void {
    this.setAttribute("zcode.tool_execution.output_bytes", finiteNonNegative(bytes));
  }

  setOutputTruncated(truncated: boolean): void {
    this.setAttribute("zcode.tool_execution.output_truncated", truncated);
  }

  startCommand(input: CommandTraceStart): CommandExecutionSpanWriter {
    return this.createCommand({ ...input, parent: this });
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishDenied(reason: "user_denied" | "policy_denied" | "unavailable" | "unknown"): void {
    this.finishDomainOutcomeIfOpen("denied", () =>
      this.setAttribute("zcode.tool_execution.permission_denial_reason", reason),
    );
  }

  finishFailed(
    stage:
      | "lookup"
      | "validation"
      | "permission"
      | "pre_hook"
      | "handler"
      | "post_hook"
      | "serialize"
      | "unhandled",
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
