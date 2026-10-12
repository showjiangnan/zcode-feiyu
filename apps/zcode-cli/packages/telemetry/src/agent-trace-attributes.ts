// Modified by ZCode Feiyu.
import { type Attributes, type Link } from "@opentelemetry/api";
import type {
  AgentTelemetryCausation,
  AgentTelemetryErrorCategory,
  AgentTelemetryExecutionContext,
  AgentTurnTraceStart,
  CommandTraceStart,
  CompactionTraceStart,
  DetachedOperationTraceStart,
  ModelAttemptTraceStart,
  ModelCallTraceStart,
} from "@zcode/contracts/telemetry";
import type { ModelCallWriter } from "./agent-trace-model-call-writer.js";
import {
  compactAttributes,
  isAbortLike,
  safeEnum,
  safeString,
  spanContextFromCausation,
  type ActiveWriterContext,
  type WriterLifecycleKeys,
  type WriterTerminalObservation,
} from "./agent-trace-support.js";

export function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

export function terminalMetricLabels(
  labels: Attributes,
  observation: WriterTerminalObservation,
): Attributes {
  return compactAttributes({
    ...labels,
    error_category: observation.errorCategory,
  });
}

export function turnMetricLabels(
  correlation: AgentTelemetryExecutionContext,
  inputSource: AgentTurnTraceStart["inputSource"],
): Attributes {
  return compactAttributes({
    actor_kind: safeEnum(correlation.actorKind),
    input_source: safeEnum(inputSource),
    launch_surface: safeEnum(correlation.launchSurface),
  });
}

export function stepMetricLabels(
  correlation: AgentTelemetryExecutionContext | undefined,
): Attributes {
  return compactAttributes({
    actor_kind: safeEnum(correlation?.actorKind),
  });
}

export function toolMetricLabels(toolName: string): Attributes {
  return {
    tool_name: safeString(toolName, 128),
  };
}

export function commandMetricLabels(input: CommandTraceStart): Attributes {
  return compactAttributes({
    command_category: safeEnum(input.category),
    command_safe_name: safeString(input.safeName, 128),
  });
}

export function compactionMetricLabels(input: CompactionTraceStart): Attributes {
  return compactAttributes({
    model_mode: safeEnum(input.modelMode),
    trigger: safeEnum(input.trigger),
  });
}

export function detachedMetricLabels(input: DetachedOperationTraceStart): Attributes {
  return compactAttributes({
    execution_kind: safeEnum(input.executionKind),
    operation: safeEnum(input.operation),
  });
}

export function modelCallMetricLabels(input: ModelCallTraceStart): Attributes {
  return compactAttributes({
    call_cause: safeEnum(input.callCause ?? "initial"),
    model_operation: safeEnum(input.operation),
    model_role: safeEnum(input.modelRole),
  });
}

export function modelAttemptMetricLabels(
  input: ModelAttemptTraceStart,
  parent: ModelCallWriter,
): Attributes {
  return compactAttributes({
    model: safeString(input.target.requestedModel, 128),
    model_operation: parent.operation,
    model_role: parent.modelRole,
    provider_kind: safeEnum(input.target.providerKind),
    transport: safeEnum(input.transport),
  });
}

export function causationLink(
  causation: AgentTelemetryCausation,
  relation: "spawned_by" | "triggered_by" | "resumed_from",
): Link {
  return {
    attributes: {
      "zcode.link.relation": relation,
    },
    context: spanContextFromCausation(causation),
  };
}

export function inheritedMetadata(
  parent: ActiveWriterContext | undefined,
  spanName: string,
): Omit<ActiveWriterContext, "activeContext" | "span"> {
  return {
    correlation: parent?.correlation,
    parent,
    spanName,
    toolCallId: parent?.toolCallId,
  };
}

export function lifecycleKeys(spanName: string): WriterLifecycleKeys {
  const prefix = `zcode.${spanName}`;
  return {
    abandonReason: `${prefix}.abandon_reason`,
    cancelReason: `${prefix}.cancel_reason`,
    errorCategory: `${prefix}.error_category`,
    errorCode: `${prefix}.error_code`,
    errorMessage: `${prefix}.error_message`,
    errorType: `${prefix}.error_type`,
    failureStage: `${prefix}.failure_stage`,
    outcome: `${prefix}.outcome`,
  };
}

export function classifyErrorCategory(error: unknown): AgentTelemetryErrorCategory {
  if (isAbortLike(error)) return "cancelled";
  if (!error || typeof error !== "object") return "unknown";
  const record = error as Record<string, unknown>;
  const status = typeof record.status === "number" ? record.status : record.statusCode;
  if (status === 401 || status === 403) return "authentication";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limit";
  const code = String(record.code ?? "").toLowerCase();
  if (code.includes("timeout")) return "timeout";
  if (
    code.includes("network") ||
    code.includes("econn") ||
    code.includes("enotfound") ||
    code.includes("tls")
  ) {
    return "network";
  }
  return "unknown";
}
