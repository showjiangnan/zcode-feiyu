// Modified by ZCode Feiyu.
import type {
  ConversationSnapshot,
  DeliveryProfile,
  ConversationDelta,
  CommandEnvelope,
  QueueItem,
  ConversationTopicFrame,
  DeliveryProfileName,
  V4ConversationRowsRangeResult,
  V4ConversationPlansResult,
  ToolCallRow,
  ConversationRowTarget,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  StableForkCandidateResolution,
  SessionConfigSeed,
  SessionUsageSeed,
  SessionSubagentsSeed,
  ConversationRowTargetAction,
  ConversationRowTargetResolution,
} from "./product-projection.js";
import {
  DELIVERY_PROFILES,
  filterConversationRowsForProfile,
  PROTOCOL_V4_LIMITS,
  clampWorkflowRunsForLegacy,
  filterConversationDeltasForProfile,
  utf8JsonByteLength,
} from "@zcode/shared/zcode-protocol-v4";
import type { Subscription } from "./conversation-topic-publisher-log-entry.js";
import { encodeConversationDeltasForLegacy } from "./conversation-workflow-run-deltas.js";
import {
  TERMINAL_PLAN_STATUSES,
  hasPlanMarkdown,
} from "./conversation-topic-publisher-log-entry.js";
import type { ConversationTopicPublisher } from "./conversation-topic-publisher.js";

export function getSnapshot(this: ConversationTopicPublisher): ConversationSnapshot {
  return this["projection"].getSnapshot();
}

export function getWireSnapshotLogicalBytes(this: ConversationTopicPublisher): number {
  return this["measureWireSnapshotBytes"](this["getWireSnapshot"]());
}

export function resolveStableForkCandidate(
  this: ConversationTopicPublisher,
  rowId: number,
): StableForkCandidateResolution {
  return this["projection"].resolveStableForkCandidate(rowId);
}

export function seedConfig(this: ConversationTopicPublisher, seed: SessionConfigSeed): void {
  this["projection"].seedConfig(seed);
  this["wireSnapshotBytesUpperBound"] = this["measureWireSnapshotBytes"](this["getWireSnapshot"]());
}

export function seedSharedContextImport(
  this: ConversationTopicPublisher,
  source: ConversationSnapshot["sharedContextImport"] | null | undefined,
): void {
  this["projection"].seedSharedContextImport(source);
  this["wireSnapshotBytesUpperBound"] = this["measureWireSnapshotBytes"](this["getWireSnapshot"]());
}

export function seedUsage(this: ConversationTopicPublisher, seed: SessionUsageSeed): void {
  this["projection"].seedUsage(seed);
  this["wireSnapshotBytesUpperBound"] = this["measureWireSnapshotBytes"](this["getWireSnapshot"]());
}

export function seedSubagents(this: ConversationTopicPublisher, seed: SessionSubagentsSeed): void {
  this["projection"].seedSubagents(seed);
  this["wireSnapshotBytesUpperBound"] = this["measureWireSnapshotBytes"](this["getWireSnapshot"]());
}

export function getWireSnapshot(
  this: ConversationTopicPublisher,
  snapshot = this["projection"].getSnapshot(),
): ConversationSnapshot {
  return this["getWireSnapshotForProfile"](DELIVERY_PROFILES.continuous, snapshot);
}

export function getWireSnapshotForProfile(
  this: ConversationTopicPublisher,
  profile: DeliveryProfile,
  snapshot = this["projection"].getSnapshot(),
): ConversationSnapshot {
  const visibleRows = filterConversationRowsForProfile(snapshot.rows.window, profile);
  const visibleSnapshot: ConversationSnapshot = {
    ...snapshot,
    rows: {
      ...snapshot.rows,
      window: visibleRows,
      totalCount: visibleRows.length,
      firstRowId: visibleRows[0]?.rowId ?? null,
    },
  };
  const limit = PROTOCOL_V4_LIMITS.snapshotTailWindowRows;
  if (visibleRows.length <= limit) return visibleSnapshot;
  return {
    ...visibleSnapshot,
    rows: { ...visibleSnapshot.rows, window: visibleRows.slice(-limit) },
  };
}

export function getWireSnapshotForSubscription(
  this: ConversationTopicPublisher,
  subscription: Subscription,
): ConversationSnapshot {
  const snapshot = this["getWireSnapshotForProfile"](subscription.profile);
  if (subscription.workflowRunDeltas || snapshot.workflowRuns === undefined) return snapshot;
  const workflowRuns = clampWorkflowRunsForLegacy(snapshot.workflowRuns);
  return workflowRuns === snapshot.workflowRuns ? snapshot : { ...snapshot, workflowRuns };
}

export function encodeDeltasForSubscription(
  this: ConversationTopicPublisher,
  deltas: readonly ConversationDelta[],
  subscription: Subscription,
): readonly ConversationDelta[] {
  const filtered = filterConversationDeltasForProfile(deltas, subscription.profile);
  if (subscription.workflowRunDeltas) return filtered;
  return encodeConversationDeltasForLegacy(filtered, this["projection"].getSnapshot().workflowRuns);
}

export function measureInputAdmissionProjectionBytes(
  this: ConversationTopicPublisher,
  envelope: CommandEnvelope,
  admission: {
    admissionSeq: number;
    admittedAt: number;
    queueItemId: string;
  },
): number | null {
  const raw = envelope.payload as {
    text?: string;
    displayText?: string;
    attachments?: QueueItem["attachments"];
    firstInput?: {
      text: string;
      attachments?: QueueItem["attachments"];
    };
  };
  const input = envelope.type === "createSession" ? raw.firstInput : raw;
  if (
    !input ||
    (envelope.type !== "createSession" &&
      envelope.type !== "sendText" &&
      envelope.type !== "sendGoalCommand" &&
      envelope.type !== "compact")
  ) {
    return null;
  }
  const snapshot = this["projection"].getSnapshot();
  const queueItem: QueueItem = {
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId: envelope.clientId || "cli",
    kind:
      envelope.type === "compact"
        ? "compact"
        : envelope.type === "sendGoalCommand"
          ? "sendGoalCommand"
          : "sendText",
    text:
      envelope.type === "compact"
        ? "/compact"
        : envelope.type === "sendGoalCommand"
          ? raw.displayText?.trim() || `/goal ${(input.text ?? "").trim()}`
          : (input.text ?? ""),
    attachments: input.attachments ?? [],
    delivery: { requested: "queue", admitted: "queue" },
    order: {
      admissionSeq: admission.admissionSeq,
      queuePosition: snapshot.queue.items.length,
    },
    steer: { state: "notRequested" },
    dispatch: { state: "queued" },
    admittedAt: admission.admittedAt,
  };
  const candidate: ConversationSnapshot = {
    ...snapshot,
    queue: { ...snapshot.queue, items: [...snapshot.queue.items, queueItem] },
  };
  return this["measureWireSnapshotBytes"](this["getWireSnapshot"](candidate));
}

export function measureWireSnapshotBytes(
  this: ConversationTopicPublisher,
  snapshot: ConversationSnapshot,
): number {
  // subscriptionId/时间/seq 使用本 publisher 可产生的最长常规表示，确保测量不是只算 payload。
  const frame: ConversationTopicFrame = {
    topic: this.topic,
    subscriptionId: `sub-${this["logEpoch"]}-${Number.MAX_SAFE_INTEGER}`,
    fromSeq: 0,
    toSeq: snapshot.seq,
    sentAt: Number.MAX_SAFE_INTEGER,
    payload: { kind: "snapshot", snapshot },
  };
  return utf8JsonByteLength(frame);
}

export function getRowsRange(
  this: ConversationTopicPublisher,
  params: {
    beforeRowId?: number;
    limit: number;
  },
  deliveryProfile: DeliveryProfileName = "replayable",
): V4ConversationRowsRangeResult {
  const snapshot = this["projection"].getSnapshot();
  const limit = Math.max(1, Math.min(params.limit, PROTOCOL_V4_LIMITS.rowsRangeMaxLimit));
  const visibleRows = filterConversationRowsForProfile(
    snapshot.rows.window,
    DELIVERY_PROFILES[deliveryProfile],
  );
  const eligible =
    params.beforeRowId === undefined
      ? visibleRows
      : visibleRows.filter((row) => row.rowId < (params.beforeRowId as number));
  const rows = eligible.slice(-limit);
  return {
    rows,
    atSeq: snapshot.seq,
    atRevision: snapshot.revision,
    atLogEpoch: this["logEpoch"],
    hasMore: eligible.length > rows.length,
  };
}

export function getPlans(this: ConversationTopicPublisher): V4ConversationPlansResult {
  const snapshot = this["projection"].getSnapshot();
  const plans = snapshot.rows.window
    .filter(
      (row): row is ToolCallRow =>
        row.kind === "toolCall" &&
        row.toolName === "ExitPlanMode" &&
        TERMINAL_PLAN_STATUSES.has(row.status) &&
        hasPlanMarkdown(row),
    )
    .toSorted((left, right) => right.rowId - left.rowId);
  return {
    plans,
    atSeq: snapshot.seq,
    atLogEpoch: this["logEpoch"],
  };
}

export function getMessageIdForRow(this: ConversationTopicPublisher, rowId: number): string | null {
  return this["projection"].getMessageIdForRow(rowId);
}

export function resolveRowActionTarget(
  this: ConversationTopicPublisher,
  target: ConversationRowTarget,
  action: ConversationRowTargetAction,
): ConversationRowTargetResolution {
  return this["projection"].resolveRowActionTarget(target, action);
}

export function getMessageIdsForTurnRow(this: ConversationTopicPublisher, rowId: number): string[] {
  return this["projection"].getMessageIdsForTurnRow(rowId);
}

export function isLatestAssistantSegmentRow(
  this: ConversationTopicPublisher,
  rowId: number,
): boolean {
  return this["projection"].isLatestAssistantSegmentRow(rowId);
}
