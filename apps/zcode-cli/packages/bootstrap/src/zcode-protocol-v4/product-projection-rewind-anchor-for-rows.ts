// Modified by ZCode Feiyu.
import type { ConversationRow, ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationEditTarget } from "./product-projection-hook-invocation-row-content.js";
import type { SessionEvent } from "@zcode/contracts";
import type { ProductProjection } from "./product-projection.js";

export function rewindAnchorForRows(
  this: ProductProjection,
  rows: readonly ConversationRow[],
  rowId: number,
): string | null {
  const row = rows.find((candidate) => candidate.rowId === rowId);
  if (!row) return null;
  const turnId = row.turnId;
  for (const [candidateRowId, messageId] of this["messageIdByRowId"]) {
    const candidate = rows.find((item) => item.rowId === candidateRowId);
    if (candidate && candidate.turnId === turnId) return messageId;
  }
  return null;
}

export function registerCanonicalUserRowTarget(
  this: ProductProjection,
  rowId: number,
  entityId: string,
  editTarget?: ConversationEditTarget,
): void {
  this["entityIdByRowId"].set(rowId, entityId);
  if (!editTarget) return;
  this["messageIdByRowId"].set(rowId, editTarget.transcriptMessageId);
  this["editTargetByEntityId"].set(entityId, editTarget);
}

export function onSessionCreated(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    contextWindow?: number;
  };
  this["contextWindowState"].maxTokens = payload.contextWindow ?? null;
  // draft 语义：会话实体已存在、无 row；phase 保持 draft，无可见 delta。
  return [];
}

export function onSessionTitleUpdated(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    title?: string;
    source?: string;
  };
  const title = payload.title ?? "";
  // core 的 titleSource 有 4 值（default/first_input/generated/custom）；投影 meta 归一为
  // default/generated/custom（first_input 归入 generated：都属"非用户显式"）。
  const source: "default" | "generated" | "custom" =
    payload.source === "custom" ? "custom" : payload.source === "default" ? "default" : "generated";
  const prev = this["snapshot"].meta;
  if (prev.titleSource === "custom" && source === "generated") return [];
  if (prev.title === title && prev.titleSource === source) return [];
  return [
    {
      op: "state.updated",
      patch: { meta: { title, titleSource: source } },
    },
  ];
}
