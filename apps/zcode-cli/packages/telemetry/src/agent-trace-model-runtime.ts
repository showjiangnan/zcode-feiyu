// Modified by ZCode Feiyu.
import { context, SpanKind } from "@opentelemetry/api";
import type {
  ModelAttemptSpanWriter,
  ModelAttemptTraceStart,
  ModelCallSpanWriter,
  ModelCallTraceStart,
} from "@zcode/contracts/telemetry";
import {
  inheritedMetadata,
  modelAttemptMetricLabels,
  modelCallMetricLabels,
} from "./agent-trace-attributes.js";
import { ModelAttemptWriter } from "./agent-trace-model-attempt-writer.js";
import { ModelCallWriter } from "./agent-trace-model-call-writer.js";
import { NOOP_MODEL_ATTEMPT_WRITER, NOOP_MODEL_CALL_WRITER } from "./agent-trace-noop.js";
import { AgentOperationTraceRuntime } from "./agent-trace-operation-runtime.js";
import {
  activeWriterContext,
  compactAttributes,
  executionProjection,
  finiteNonNegative,
  integer,
  safeEnum,
  safeId,
  safeString,
} from "./agent-trace-support.js";
import { modelAttemptCompatibilityAttributes } from "./compatibility-adapters.js";

export class AgentModelTraceRuntime extends AgentOperationTraceRuntime {
  startCall(input: ModelCallTraceStart): ModelCallSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "model_call",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent?.correlation, {
              includeActor: true,
              includeQuery: true,
              includeSession: true,
            }),
            "zcode.execution.logical_call_id": safeId(input.logicalCallId),
            "zcode.model_call.operation": safeEnum(input.operation),
            "zcode.model_call.streaming": input.streaming,
            "zcode.model_call.model_role": safeEnum(input.modelRole),
            "zcode.model_call.requested_provider_id": safeString(input.requested.providerId, 128),
            "zcode.model_call.requested_model": safeString(input.requested.requestedModel, 128),
            "zcode.model_call.reasoning_capability": safeEnum(input.requested.reasoning.capability),
            "zcode.model_call.reasoning_requested_state": safeEnum(
              input.requested.reasoning.requestedState,
            ),
            "zcode.model_call.reasoning_requested_control": safeEnum(
              input.requested.reasoning.requestedControl,
            ),
            "zcode.model_call.reasoning_requested_level": safeString(
              input.requested.reasoning.requestedLevel,
              128,
            ),
            "zcode.model_call.reasoning_requested_budget_tokens": integer(
              input.requested.reasoning.requestedBudgetTokens,
            ),
            "zcode.model_call.call_cause": safeEnum(input.callCause),
            "zcode.model_call.previous_logical_call_id": safeId(input.previousLogicalCallId),
          }),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "model_call",
          toolCallId: parent?.toolCallId,
        });
        return this.track(
          new ModelCallWriter(
            span,
            parentContext,
            {
              ...inheritedMetadata(parent, "model_call"),
            },
            this.health,
            this.metrics,
            modelCallMetricLabels(input),
            (writer) => this.activeWriters.delete(writer),
            (writer, attempt) => this.startAttempt(writer, attempt),
            safeId(input.logicalCallId),
            safeEnum(input.operation),
            safeEnum(input.modelRole),
          ),
        );
      },
      NOOP_MODEL_CALL_WRITER,
    );
  }

  protected startAttempt(
    parentWriter: ModelCallWriter,
    input: ModelAttemptTraceStart,
  ): ModelAttemptSpanWriter {
    const parent = parentWriter.state;
    return this.safeCreate(
      "model_attempt",
      () => {
        const target = input.target;
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent.correlation, {
              includeActor: true,
              includeQuery: true,
              includeSession: true,
            }),
            "zcode.execution.tool_call_id": safeId(parent.toolCallId),
            "zcode.execution.logical_call_id": parentWriter.logicalCallId,
            "zcode.execution.model_operation": parentWriter.operation,
            "zcode.execution.model_role": parentWriter.modelRole,
            "zcode.model_attempt.request_id": safeId(input.requestId),
            "zcode.model_attempt.attempt_number": integer(input.attemptNumber),
            "zcode.model_attempt.max_attempts": integer(input.maxAttempts),
            "zcode.model_attempt.attempt_cause": safeEnum(input.attemptCause),
            "zcode.model_attempt.previous_request_id": safeId(input.previousRequestId),
            "zcode.model_attempt.retry_delay_ms": finiteNonNegative(input.retryDelayMs),
            "zcode.model_attempt.provider_id": safeString(target.providerId, 128),
            "zcode.model_attempt.provider_kind": safeEnum(target.providerKind),
            "zcode.model_attempt.provider_origin": safeString(target.providerOrigin),
            "zcode.model_attempt.provider_route": safeString(target.providerRoute),
            "zcode.model_attempt.requested_model": safeString(target.requestedModel, 128),
            "zcode.model_attempt.transport": safeEnum(input.transport),
            "zcode.model_attempt.api_operation": safeEnum(input.apiOperation),
            "zcode.model_attempt.reasoning_capability": safeEnum(target.reasoning.capability),
            "zcode.model_attempt.reasoning_requested_state": safeEnum(
              target.reasoning.requestedState,
            ),
            "zcode.model_attempt.reasoning_requested_control": safeEnum(
              target.reasoning.requestedControl,
            ),
            "zcode.model_attempt.reasoning_requested_level": safeString(
              target.reasoning.requestedLevel,
              128,
            ),
            "zcode.model_attempt.reasoning_requested_budget_tokens": integer(
              target.reasoning.requestedBudgetTokens,
            ),
            ...modelAttemptCompatibilityAttributes(target),
          }),
          context: parent.activeContext,
          correlation: parent.correlation,
          kind: SpanKind.CLIENT,
          parent,
          spanName: "model_attempt",
          toolCallId: parent.toolCallId,
        });
        return this.track(
          new ModelAttemptWriter(
            span,
            parent.activeContext,
            inheritedMetadata(parent, "model_attempt"),
            this.health,
            this.metrics,
            modelAttemptMetricLabels(input, parentWriter),
            () => parentWriter.recordAttemptFailed(),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_MODEL_ATTEMPT_WRITER,
    );
  }
}
