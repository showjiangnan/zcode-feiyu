// Modified by ZCode Feiyu.
import type { SessionEvent } from "@zcode/contracts";
import type {
  ConversationDelta,
  TurnWorkSegment,
  TurnHeaderRow,
  AssistantTextRow,
  ConversationRow,
  ToolCallRow,
  SubagentRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { CanonicalOpenSegmentIdentity } from "./event-normalizer.js";
import type { ProductProjection } from "./product-projection.js";

export function highspeedTimingForTurn(
  this: ProductProjection,
  turnId: string,
  activeMs?: number,
): { modelDurationMs: number; toolDurationMs: number; otherDurationMs: number } | undefined {
  const modelDurationMs = this["highspeedModelDurationByTurnId"].get(turnId);
  const intervals = this["highspeedToolIntervalsByTurnId"].get(turnId);
  if (modelDurationMs === undefined && intervals === undefined) return undefined;
  const sorted = [...(intervals?.values() ?? [])]
    .filter((interval) => interval.endedAt !== undefined)
    .sort((left, right) => left.startedAt - right.startedAt);
  let toolDurationMs = 0;
  let unionEnd = -1;
  for (const interval of sorted) {
    const start = Math.max(0, interval.startedAt);
    const end = Math.max(start, interval.endedAt ?? start);
    if (start > unionEnd) toolDurationMs += end - start;
    else if (end > unionEnd) toolDurationMs += end - unionEnd;
    unionEnd = Math.max(unionEnd, end);
  }
  const model = Math.max(0, modelDurationMs ?? 0);
  const otherDurationMs = Math.max(
    0,
    (activeMs ?? model + toolDurationMs) - model - toolDurationMs,
  );
  this["highspeedModelDurationByTurnId"].delete(turnId);
  this["highspeedToolIntervalsByTurnId"].delete(turnId);
  return { modelDurationMs: model, toolDurationMs, otherDurationMs };
}

export function openGuidedWorkSegment(
  this: ProductProjection,
  event: SessionEvent,
  triggerEntityId: string,
): ConversationDelta[] {
  const row = this["turnHeaderForEvent"](event);
  if (!row || row.executionKind === "controlOnly") return [];
  const startedAt = this["ms"](event);
  const existingSegments: TurnWorkSegment[] = row.workSegments ?? [
    {
      segmentId: `${row.turnId}:initial`,
      startedAt: row.startedAt,
    },
  ];
  // 旧 UI 为整个 product turn 只维护一个折叠状态，accepted guide 只能
  // 作为普通行插入，无法恢复独立工作区。分段边界必须由 CLI 记录，React 不能按邻接行猜。
  const workSegments = [
    ...this["completeWorkSegments"](existingSegments, startedAt),
    {
      segmentId: triggerEntityId,
      triggerEntityId,
      startedAt,
    },
  ];
  return [{ op: "row.upserted", row: { ...row, workSegments } }];
}

export function completeWorkSegments(
  this: ProductProjection,
  segments: readonly TurnWorkSegment[],
  endedAt: number,
): TurnWorkSegment[] {
  return segments.map((segment, index) =>
    index === segments.length - 1 && segment.endedAt === undefined
      ? {
          ...segment,
          endedAt,
          activeMs: Math.max(0, endedAt - segment.startedAt),
        }
      : segment,
  );
}

export function turnHeaderForEvent(
  this: ProductProjection,
  event: SessionEvent,
): TurnHeaderRow | undefined {
  const rowId = this["turnHeaderRowIdByTurnId"].get(this["turnIdOf"](event));
  if (rowId === undefined) return undefined;
  const row = this["findRow"](rowId);
  return row?.kind === "turnHeader" ? row : undefined;
}

export function markStableForkAssistant(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const turnId = this["turnIdOf"](event);
  const rows = this["snapshot"].rows.window;
  const headerRowId = this["turnHeaderRowIdByTurnId"].get(turnId);
  const headerIndex = headerRowId === undefined ? undefined : this["rowIndexById"].get(headerRowId);
  const startIndex = headerIndex === undefined ? 0 : headerIndex + 1;
  let row: AssistantTextRow | undefined;
  // 性能问题根因：旧实现每个成功 turn 都复制并反转完整历史 rows，冷恢复会累积为
  // 近似 O(turns * rows) 的分配与扫描。当前 turn 的行只会出现在自身 header 之后。
  for (let index = rows.length - 1; index >= startIndex; index -= 1) {
    const candidate = rows[index];
    if (candidate?.kind !== "assistantText" || candidate.turnId !== turnId) continue;
    row = candidate;
    break;
  }
  if (!row || !this["messageIdByRowId"].has(row.rowId)) return [];
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        state: "complete",
        actions: { ...row.actions, canFork: true },
      },
    },
  ];
}

export function isRunning(this: ProductProjection): boolean {
  const phase = this["snapshot"].control.phase;
  return phase === "running" || phase === "prewarming";
}

export function isMirroredSubagentToolEvent(this: ProductProjection, event: SessionEvent): boolean {
  const payload = event.payload as unknown as Record<string, unknown>;
  // Bug 原因：child tool lifecycle 会镜像到父 runtime，但它不是父 session 的工具事实。
  // V4 过去把 mirror 当普通 ToolCallRow，导致 main timeline 展示 child 的 Read/Bash，
  // 并让 replayable snapshot 同样带上脏 row。完整工具历史只应由 child topic 物化。
  return payload.source === "subagent";
}

export function openAssistantSegments(
  this: ProductProjection,
): Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>> {
  const segments: Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>> = {};
  const text = this["openSegmentIdentity"](this["streamingTextRowId"]);
  const reasoning = this["openSegmentIdentity"](this["streamingReasoningRowId"]);
  if (text) segments.text = text;
  if (reasoning) segments.reasoning = reasoning;
  return segments;
}

export function openSegmentIdentity(
  this: ProductProjection,
  rowId: number | null,
): CanonicalOpenSegmentIdentity | null {
  if (rowId === null) return null;
  const entityId = this["entityIdByRowId"].get(rowId);
  if (!entityId) return null;
  return {
    entityId,
    transcriptMessageId: this["messageIdByRowId"].get(rowId) ?? null,
  };
}

export function rowBase(
  this: ProductProjection,
  event: SessionEvent,
  turnId: string,
  entityId = String(event.id),
): {
  rowId: number;
  turnId: string;
  entityId: string;
  productTurnId: string;
  visibility: "visible";
  createdAt: number;
  createdAtSeq: number;
} {
  const rowId = this["nextRowId"]++;
  this["entityIdByRowId"].set(rowId, entityId);
  return {
    rowId,
    turnId,
    entityId,
    productTurnId: turnId,
    visibility: "visible" as const,
    createdAt: this["ms"](event),
    createdAtSeq: event.sequenceNumber,
  };
}

export function turnIdOf(this: ProductProjection, event: SessionEvent): string {
  const runtimeTurnId = String(event.turnId ?? this["currentTurnId"] ?? "turn-unknown");
  // queue drain 切轮后，同一 runtimeTurn 的后续事件行归入最新 productTurn。
  return this["productTurnIdByRuntimeTurnId"].get(runtimeTurnId) ?? runtimeTurnId;
}

export function ms(this: ProductProjection, event: SessionEvent): number {
  return event.timestamp.getTime();
}

export function findRow(this: ProductProjection, rowId: number): ConversationRow | undefined {
  const index = this["rowIndexById"].get(rowId);
  return index === undefined ? undefined : this["snapshot"].rows.window[index];
}

export function updateRowIndexAfterImmutableApply(
  this: ProductProjection,
  previousRowsLength: number,
  deltas: readonly ConversationDelta[],
): void {
  if (deltas.some((delta) => delta.op === "row.removed")) {
    this["rowIndexById"] = new Map(
      this["snapshot"].rows.window.map((row, index) => [row.rowId, index]),
    );
    return;
  }
  let nextIndex = previousRowsLength;
  for (const delta of deltas) {
    if (delta.op !== "row.appended") continue;
    this["rowIndexById"].set(delta.row.rowId, nextIndex);
    nextIndex += 1;
  }
}

export function findToolRow(this: ProductProjection, toolCallId: string): ToolCallRow | undefined {
  const rowId = this["toolRowIdByCallId"].get(toolCallId);
  if (rowId === undefined) return undefined;
  const row = this["findRow"](rowId);
  return row?.kind === "toolCall" ? row : undefined;
}

export function findSubagentRow(this: ProductProjection, agentId: string): SubagentRow | undefined {
  const rowId = this["subagentRowIdByAgentId"].get(agentId);
  if (rowId === undefined) return undefined;
  const row = this["findRow"](rowId);
  return row?.kind === "subagent" ? row : undefined;
}
