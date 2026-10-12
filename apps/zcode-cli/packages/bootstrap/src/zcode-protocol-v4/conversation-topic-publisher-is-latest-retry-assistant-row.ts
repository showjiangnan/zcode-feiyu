// Modified by ZCode Feiyu.
import type { SessionEvent } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { PROTOCOL_V4_LIMITS, utf8JsonByteLength } from "@zcode/shared/zcode-protocol-v4";
import {
  PROJECTION_TERMINAL_RESERVE_BYTES,
  ProjectionPayloadTooLargeError,
  appendConversationSubscriberBuffer,
  hydrationSequenceNumberBytes,
  coldHydrationJsonByteLength,
  HYDRATION_EVENT_WIRE_OVERHEAD_BYTES,
  HYDRATION_ACTION_BYTES_PER_WIRE_ROW,
} from "./conversation-topic-publisher-log-entry.js";
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import { workflowRunDeltaGrowthUpperBound } from "./conversation-workflow-run-deltas.js";
import type {
  ConversationSubscribeParams,
  ConversationSubscribeResult,
} from "./conversation-topic-publisher-log-entry.js";
import type { ConversationTopicPublisher } from "./conversation-topic-publisher.js";

export function isLatestRetryAssistantRow(
  this: ConversationTopicPublisher,
  rowId: number,
): boolean {
  return this["projection"].isLatestRetryAssistantRow(rowId);
}

export function isLatestEditableUserRow(this: ConversationTopicPublisher, rowId: number): boolean {
  return this["projection"].isLatestEditableUserRow(rowId);
}

export function getTurnIdForRow(this: ConversationTopicPublisher, rowId: number): string | null {
  return this["projection"].getTurnIdForRow(rowId);
}

export function getDroppedContentStreamEventCount(this: ConversationTopicPublisher): number {
  return this["projection"].getDroppedContentStreamEventCount();
}

export function getTurnRewindAnchor(
  this: ConversationTopicPublisher,
  rowId: number,
): string | null {
  return this["projection"].getTurnRewindAnchor(rowId);
}

export function ingest(this: ConversationTopicPublisher, event: SessionEvent): void {
  const projectionLimit =
    event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError
      ? PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
      : PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;
  const streamingAppend = this["projection"].establishedStreamingAppend(event);
  const streamingUpperBound =
    streamingAppend === null ? null : utf8JsonByteLength(streamingAppend) + 64;
  let deltas: ConversationDelta[] | null;
  if (
    streamingUpperBound !== null &&
    this["wireSnapshotBytesUpperBound"] + streamingUpperBound <= projectionLimit
  ) {
    deltas = this["projection"].applyEvent(event);
    this["wireSnapshotBytesUpperBound"] += streamingUpperBound;
  } else {
    let candidateBytes = 0;
    let nextUpperBound = 0;
    deltas = this["projection"].applyEventAtomically(event, (snapshot, produced) => {
      // dwf 快路径：这条事件只产键级增量时，它们的字节数就是快照增长的上界（一条 upsert
      // 最多把自己那点内容加进去，removed 只会让快照变小），不必把整份快照再序列化一遍
      // ——那一次 JSON.stringify 是每条引擎事件都要付的 MB 级开销，也是这次改造的另一半。
      // 判据用的是**实际产出**而不是预演，所以 diff 退化出的整键 patch 自然落回精确路径。
      const growth = workflowRunDeltaGrowthUpperBound(produced);
      if (growth !== null && this["wireSnapshotBytesUpperBound"] + growth <= projectionLimit) {
        nextUpperBound = this["wireSnapshotBytesUpperBound"] + growth;
        return true;
      }
      candidateBytes = this["measureWireSnapshotBytes"](this["getWireSnapshot"](snapshot));
      nextUpperBound = candidateBytes;
      return candidateBytes <= projectionLimit;
    });
    if (deltas === null) throw new ProjectionPayloadTooLargeError(candidateBytes);
    this["wireSnapshotBytesUpperBound"] = nextUpperBound;
  }
  this["log"].push({ seq: event.sequenceNumber, deltas });
  while (this["log"].length > this["retention"]) {
    const evicted = this["log"].shift();
    if (evicted) this["floorSeq"] = evicted.seq;
  }
  if (deltas.length === 0) return;
  for (const subscription of this["subscriptions"].values()) {
    if (subscription.resyncRequired) continue;
    const filtered = this["encodeDeltasForSubscription"](deltas, subscription);
    const next = appendConversationSubscriberBuffer(
      subscription.buffer,
      filtered,
      this["subscriberBufferLimits"](),
    );
    if (next.kind === "overflow") {
      subscription.buffer = [];
      subscription.bufferBytes = 0;
      subscription.resyncRequired = true;
      continue;
    }
    subscription.buffer = next.deltas;
    subscription.bufferBytes = next.encodedBytes;
  }
}

export function tryBatchHydration(
  this: ConversationTopicPublisher,
  events: readonly SessionEvent[],
): boolean {
  this["projection"].beginHydrationReplay();
  let measuredBytes = this["wireSnapshotBytesUpperBound"];
  let measuredSequenceNumberBytes = hydrationSequenceNumberBytes(
    this["projection"].getSnapshot().seq,
  );
  let encodedGrowthSinceMeasurement = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const deltas = this["projection"].applyHydrationEvent(event);
    const finalEvent = index === events.length - 1;
    const projectionLimit = this["projectionLimitForEvent"](event);
    const mustMeasureSnapshot = finalEvent || deltas.some((delta) => delta.op === "row.removed");
    if (finalEvent) this["projection"].completeHydrationReplay();
    const snapshot = this["projection"].getSnapshot();
    if (!mustMeasureSnapshot && deltas.length > 0) {
      let wireRowIds: Set<number> | undefined;
      const wireDeltas = deltas.filter((delta) => {
        if (delta.op === "state.updated" || delta.op === "row.appended") return true;
        if (delta.op === "row.removed") return false;
        // 4b-2：插件资源通知只走实时增量，不进冷启动测量。
        if (
          delta.op === "pluginUi.resourceUpdated" ||
          delta.op === "pluginUi.resourceListChanged" ||
          delta.op === "pluginUi.appToolCall" ||
          delta.op === "pluginUi.instanceClosed"
        )
          return false;
        // 键级增量作用在状态键上，不在 60 行 wire tail 里——没有「已滑出窗口所以不计」这一说，
        // 与 state.updated 同规一律计入。
        if (delta.op === "workflowRun.updated" || delta.op === "workflowRun.removed") return true;
        wireRowIds ??= new Set(
          snapshot.rows.window
            .slice(-PROTOCOL_V4_LIMITS.snapshotTailWindowRows)
            .map((row) => row.rowId),
        );
        const rowId = delta.op === "row.upserted" ? delta.row.rowId : delta.rowId;
        return wireRowIds.has(rowId);
      });
      if (wireDeltas.length > 0) {
        encodedGrowthSinceMeasurement +=
          coldHydrationJsonByteLength({ kind: "deltas", deltas: wireDeltas }) +
          HYDRATION_EVENT_WIRE_OVERHEAD_BYTES;
      }
    }
    const actionBytesUpperBound = finalEvent
      ? 0
      : Math.min(snapshot.rows.window.length, PROTOCOL_V4_LIMITS.snapshotTailWindowRows) *
        HYDRATION_ACTION_BYTES_PER_WIRE_ROW;
    const currentSequenceNumberBytes = hydrationSequenceNumberBytes(snapshot.seq);
    const sequenceNumberGrowth = Math.max(
      0,
      currentSequenceNumberBytes - measuredSequenceNumberBytes,
    );
    let upperBound =
      measuredBytes + encodedGrowthSinceMeasurement + sequenceNumberGrowth + actionBytesUpperBound;
    if (mustMeasureSnapshot || upperBound > projectionLimit) {
      // 保守 delta 累计值一旦超限就直接回退 strict 的话，重复 upsert
      // 即使未增大 snapshot 也会误回退；固定 32-event 重测还会反复序列化 checkpoint。
      measuredBytes = this["measureWireSnapshotBytes"](this["getWireSnapshot"]());
      measuredSequenceNumberBytes = currentSequenceNumberBytes;
      encodedGrowthSinceMeasurement = 0;
      upperBound = measuredBytes + actionBytesUpperBound;
    }
    if (upperBound > projectionLimit) return false;
  }
  if (events.length === 0) {
    this["projection"].completeHydrationReplay();
    measuredBytes = this["measureWireSnapshotBytes"](this["getWireSnapshot"]());
  }
  this["wireSnapshotBytesUpperBound"] = measuredBytes;
  return true;
}

export function projectionLimitForEvent(
  this: ConversationTopicPublisher,
  event: SessionEvent,
): number {
  return event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError
    ? PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
    : PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;
}

export function subscribe(
  this: ConversationTopicPublisher,
  params: ConversationSubscribeParams,
): ConversationSubscribeResult {
  const result = this.subscribeReserved(params);
  result.reservation?.commit();
  return result;
}
