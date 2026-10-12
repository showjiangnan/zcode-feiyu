// Modified by ZCode Feiyu.
import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import type {
  CommandExecutionSpanWriter,
  CommandTraceStart,
  CompactionTraceStart,
  ContextCompactionSpanWriter,
  DetachedOperationSpanWriter,
  DetachedOperationTraceStart,
} from "@zcode/contracts/telemetry";
import {
  causationLink,
  commandMetricLabels,
  compactionMetricLabels,
  detachedMetricLabels,
  inheritedMetadata,
} from "./agent-trace-attributes.js";
import {
  NOOP_COMMAND_WRITER,
  NOOP_COMPACTION_WRITER,
  NOOP_DETACHED_WRITER,
} from "./agent-trace-noop.js";
import {
  CommandWriter,
  CompactionWriter,
  DetachedWriter,
} from "./agent-trace-operation-writers.js";
import { AgentTraceRuntimeState } from "./agent-trace-state.js";
import {
  activeWriterContext,
  compactAttributes,
  contextFromCausation,
  executionProjection,
  finiteNonNegative,
  integer,
  safeEnum,
  safeId,
  safeString,
} from "./agent-trace-support.js";
import { ToolWriter } from "./agent-trace-turn-writers.js";

export class AgentOperationTraceRuntime extends AgentTraceRuntimeState {
  startCompaction(input: CompactionTraceStart): ContextCompactionSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "context_compaction",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent?.correlation),
            "zcode.context_compaction.trigger": safeEnum(input.trigger),
            "zcode.context_compaction.phase": safeEnum(input.phase),
            "zcode.context_compaction.model_mode": safeEnum(input.modelMode),
            "zcode.context_compaction.outer_attempt": integer(input.outerAttempt),
            "zcode.context_compaction.max_attempts": integer(input.maxAttempts),
            "zcode.context_compaction.triggering_step_index": integer(input.triggeringStepIndex),
            "zcode.context_compaction.policy_context_window_tokens": finiteNonNegative(
              input.policyContextWindowTokens,
            ),
            "zcode.context_compaction.threshold_tokens": finiteNonNegative(input.thresholdTokens),
            "zcode.context_compaction.token_source": safeEnum(input.tokenSource),
            "zcode.context_compaction.recovered_from_logical_call_id": safeId(
              input.recoveredFromLogicalCallId,
            ),
          }),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "context_compaction",
          toolCallId: parent?.toolCallId,
        });
        return this.track(
          new CompactionWriter(
            span,
            parentContext,
            inheritedMetadata(parent, "context_compaction"),
            this.health,
            this.metrics,
            compactionMetricLabels(input),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_COMPACTION_WRITER,
    );
  }

  startDetachedOperation(input: DetachedOperationTraceStart): DetachedOperationSpanWriter {
    const linkedRoot = input.executionKind !== "foreground";
    const links =
      input.causation && linkedRoot
        ? [
            causationLink(
              input.causation,
              input.trigger === "recovery" ? "resumed_from" : "triggered_by",
            ),
          ]
        : undefined;
    return this.safeCreate(
      "detached_operation",
      () => {
        const parentContext =
          input.causation && !linkedRoot ? contextFromCausation(input.causation) : ROOT_CONTEXT;
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(input.context, {
              includeActor: true,
              includeQuery: true,
              includeSession: true,
            }),
            "zcode.detached_operation.operation": safeEnum(input.operation),
            "zcode.detached_operation.execution_kind": safeEnum(input.executionKind),
            "zcode.detached_operation.trigger": safeEnum(input.trigger),
            "zcode.detached_operation.target_kind": safeEnum(input.targetKind),
            "zcode.detached_operation.goal_iteration": integer(input.goalIteration),
            "zcode.detached_operation.chunk_index": integer(input.chunkIndex),
            "zcode.detached_operation.chunk_count": integer(input.chunkCount),
          }),
          context: parentContext,
          correlation: input.context,
          links,
          spanName: "detached_operation",
        });
        return this.track(
          new DetachedWriter(
            span,
            parentContext,
            {
              correlation: input.context,
              spanName: "detached_operation",
            },
            this.health,
            this.metrics,
            detachedMetricLabels(input),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_DETACHED_WRITER,
    );
  }

  protected startCommand(
    input: CommandTraceStart & { parent: ToolWriter },
  ): CommandExecutionSpanWriter {
    const parent = input.parent.state;
    return this.safeCreate(
      "command_execution",
      () => {
        const span = this.startSpan({
          attributes: compactAttributes({
            ...executionProjection(parent.correlation),
            "zcode.execution.tool_call_id": safeId(parent.toolCallId),
            "zcode.command_execution.safe_name": safeString(input.safeName, 128),
            "zcode.command_execution.category": safeEnum(input.category),
            "zcode.command_execution.command_count": integer(input.commandCount),
            "zcode.command_execution.shell_kind": safeEnum(input.shellKind),
            "zcode.command_execution.sandboxed": input.sandboxed,
          }),
          context: parent.activeContext,
          correlation: parent.correlation,
          parent,
          spanName: "command_execution",
          toolCallId: parent.toolCallId,
        });
        return this.track(
          new CommandWriter(
            span,
            parent.activeContext,
            inheritedMetadata(parent, "command_execution"),
            this.health,
            this.metrics,
            commandMetricLabels(input),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_COMMAND_WRITER,
    );
  }
}
