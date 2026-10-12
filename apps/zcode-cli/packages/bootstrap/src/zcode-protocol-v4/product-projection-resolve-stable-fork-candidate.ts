// Modified by ZCode Feiyu.
import type { StableForkCandidateResolution } from "./product-projection-hook-invocation-row-content.js";
import type { SessionEvent } from "@zcode/contracts";
import type { ConversationDelta, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import {
  createMutableConversationSnapshotAccumulator,
  applyConversationDeltasMutable,
  applyConversationDeltas,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionEventType } from "@zcode/contracts";
import { normalizeConversationEvent } from "./event-normalizer.js";
import { clearSettledOutputPreviews } from "./product-projection-bash-progress.js";
import type { ProductProjection } from "./product-projection.js";

export function resolveStableForkCandidate(
  this: ProductProjection,
  rowId: number,
): StableForkCandidateResolution {
  if (this["snapshot"].control.activeWorks.some((work) => work.kind === "compact")) {
    return { ok: false, reasonCode: "guard.compactOperationLock" };
  }
  const row = this["findRow"](rowId);
  if (row?.kind !== "assistantText") {
    return { ok: false, reasonCode: "guard.forkAssistantOnly" };
  }
  const headerRowId = this["turnHeaderRowIdByTurnId"].get(row.turnId);
  const header = headerRowId === undefined ? undefined : this["findRow"](headerRowId);
  if (
    row.state !== "complete" ||
    row.actions?.canFork !== true ||
    header?.kind !== "turnHeader" ||
    header.state !== "completedSuccess" ||
    !this.isLatestAssistantSegmentRow(rowId)
  ) {
    return { ok: false, reasonCode: "guard.forkTargetNotStable" };
  }
  const boundaryMessageId = this["messageIdByRowId"].get(rowId);
  if (!boundaryMessageId) {
    return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
  }
  const startMessageId =
    this["snapshot"].rows.window
      .filter((candidate) => candidate.turnId === row.turnId && candidate.kind === "userInput")
      .map((candidate) => this["messageIdByRowId"].get(candidate.rowId))
      .find((messageId): messageId is string => Boolean(messageId)) ?? null;
  return {
    ok: true,
    candidate: {
      productTurnId: row.turnId,
      transcriptTurnId: this["runtimeTurnIdByProductTurnId"].get(row.turnId) ?? row.turnId,
      startMessageId,
      boundaryMessageId,
    },
  };
}

export function isLatestRetryAssistantRow(this: ProductProjection, rowId: number): boolean {
  const row = this["findRow"](rowId);
  return Boolean(
    row?.kind === "assistantText" &&
    row.actions?.canRetry === true &&
    this["messageIdByRowId"].has(rowId),
  );
}

export function isLatestEditableUserRow(this: ProductProjection, rowId: number): boolean {
  const row = this["findRow"](rowId);
  return Boolean(
    row?.kind === "userInput" &&
    row.origin === "realUser" &&
    row.actions?.canEdit === true &&
    this["messageIdByRowId"].has(rowId),
  );
}

export function getTurnIdForRow(this: ProductProjection, rowId: number): string | null {
  return this["findRow"](rowId)?.turnId ?? null;
}

export function applyEvent(this: ProductProjection, event: SessionEvent): ConversationDelta[] {
  return this["applyEventInternal"](event, true);
}

export function beginHydrationReplay(this: ProductProjection): void {
  if (this["hydrationAccumulator"]) throw new Error("hydration replay already active");
  this["hydrationAccumulator"] = createMutableConversationSnapshotAccumulator(this["snapshot"]);
  this["snapshot"] = this["hydrationAccumulator"].snapshot;
  this["rowIndexById"] = this["hydrationAccumulator"].rowIndexById;
}

export function applyHydrationEvent(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  if (!this["hydrationAccumulator"]) throw new Error("hydration replay is not active");
  return this["applyEventInternal"](event, false);
}

export function completeHydrationReplay(this: ProductProjection): ConversationDelta[] {
  if (!this["hydrationAccumulator"]) throw new Error("hydration replay is not active");
  const deltas = this["materializeCommandRowActions"]([]);
  applyConversationDeltasMutable(this["hydrationAccumulator"], deltas);
  this["hydrationAccumulator"] = null;
  return deltas;
}

export function applyEventInternal(
  this: ProductProjection,
  event: SessionEvent,
  materializeActions: boolean,
): ConversationDelta[] {
  if (event.type === SessionEventType.SubagentSpawned) {
    const childSessionId = this["stringPayload"](
      event.payload as Record<string, unknown>,
      "childSessionId",
    );
    // live spawn 已经过 core persist-before-publish 闸门；若它是旧 ghost 的合法 resume，
    // 以新事件恢复资格。hydration 期间 seed 尚未建立排除集合，不会误放历史引用。
    if (childSessionId) this["invalidSubagentChildSessionIds"].delete(childSessionId);
  }
  const runtimeTurnId = String(event.turnId ?? this["currentTurnId"] ?? "turn-unknown");
  const productTurnId =
    event.type === SessionEventType.TurnStarted
      ? undefined
      : (this["productTurnIdByRuntimeTurnId"].get(runtimeTurnId) ?? runtimeTurnId);
  const reduced =
    event.type === SessionEventType.AssistantFeedbackUpdated
      ? this["onAssistantFeedbackUpdated"](event)
      : event.type === SessionEventType.HighspeedMetricsUpdated
        ? this["onHighspeedMetricsUpdated"](event)
        : event.type === SessionEventType.TurnExecutionModelFallback
          ? this["onTurnExecutionModelFallback"](event)
          : (() => {
              const fact = normalizeConversationEvent(event, {
                productTurnId,
                openAssistantSegments: this["openAssistantSegments"](),
              });
              this["normalizationDiagnostics"].push(...fact.diagnostics);
              return this["reduce"](fact);
            })();
  const subagentDeltas = this["shouldMaterializeSubagentProjection"](reduced)
    ? this["materializeSubagentProjection"](reduced)
    : [];
  const reducedWithSubagents = [...reduced, ...subagentDeltas];
  // row、命令 target 与 actions 必须属于同一个 materialization transaction。
  // 旧实现只维护 side-map/最新行判断，UI action 由别处推断，cold/tool-only/failed
  // 轮会出现“入口可见但 target 不可解析”，新目标出现后旧入口也不会撤销。
  const deltas = materializeActions
    ? [...reducedWithSubagents, ...this["materializeCommandRowActions"](reducedWithSubagents)]
    : reducedWithSubagents;
  const finalDeltas = this["attachRevision"](clearSettledOutputPreviews(deltas));
  if (this["hydrationAccumulator"]) {
    applyConversationDeltasMutable(this["hydrationAccumulator"], finalDeltas);
    this["snapshot"].seq = event.sequenceNumber;
  } else {
    const previousRowsLength = this["snapshot"].rows.window.length;
    this["snapshot"] = {
      ...applyConversationDeltas(this["snapshot"], finalDeltas),
      seq: event.sequenceNumber,
    };
    this["updateRowIndexAfterImmutableApply"](previousRowsLength, finalDeltas);
  }
  this["updateToolIndexesAfterDeltas"](finalDeltas);
  return finalDeltas;
}

export function applyEventAtomically(
  this: ProductProjection,
  event: SessionEvent,
  accept: (snapshot: ConversationSnapshot, deltas: readonly ConversationDelta[]) => boolean,
): ConversationDelta[] | null {
  const candidate = this["cloneProjection"]();
  const deltas = candidate.applyEvent(event);
  if (!accept(candidate["snapshot"], deltas)) return null;
  this["adoptProjection"](candidate);
  return deltas;
}
