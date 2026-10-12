// Modified by ZCode Feiyu.
import type {
  SessionSubagentsSeed,
  ConversationEditTarget,
  ConversationRowTargetAction,
  ConversationRowTargetResolution,
} from "./product-projection-hook-invocation-row-content.js";
import type { ConversationRowTarget } from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjection } from "./product-projection.js";

export function seedSubagents(this: ProductProjection, seed: SessionSubagentsSeed): void {
  const childSessionIds = [...new Set(seed.childSessionIds)];
  const allowed = new Set(childSessionIds);
  this["invalidSubagentChildSessionIds"] = new Set(
    this["snapshot"].rows.window.flatMap((row) =>
      row.kind === "subagent" && row.childSessionId && !allowed.has(row.childSessionId)
        ? [row.childSessionId]
        : [],
    ),
  );
  const running = seed.running.filter((item) => allowed.has(item.childSessionId));
  this["snapshot"] = {
    ...this["snapshot"],
    subagents: {
      // 非空 cold manifest 必须至少从 1 开始；renderer 用 0 区分尚未建立权威态，
      // 否则旧 session 的 stateRevision=0 会让 child tab 失效同步被永久跳过。
      revision: Math.max(childSessionIds.length > 0 ? 1 : 0, Math.floor(seed.revision)),
      childSessionIds,
      running,
      endedTotal: Math.max(0, childSessionIds.length - running.length),
    },
  };
}

export function getMessageIdForRow(this: ProductProjection, rowId: number): string | null {
  return this["messageIdByRowId"].get(rowId) ?? null;
}

export function getEntityIdForRow(this: ProductProjection, rowId: number): string | null {
  return this["entityIdByRowId"].get(rowId) ?? null;
}

export function resolveEditTarget(
  this: ProductProjection,
  rowId: number,
): ConversationEditTarget | null {
  if (!this.isLatestEditableUserRow(rowId)) return null;
  const entityId = this["entityIdByRowId"].get(rowId);
  return entityId ? this.resolveEditTargetByEntityId(entityId) : null;
}

export function resolveEditTargetByEntityId(
  this: ProductProjection,
  entityId: string,
): ConversationEditTarget | null {
  if (entityId !== this["currentEditableEntityId"]) return null;
  const target = this["editTargetByEntityId"].get(entityId);
  return target ? { ...target, intent: { ...target.intent } } : null;
}

export function resolveRowActionTarget(
  this: ProductProjection,
  target: ConversationRowTarget,
  action: ConversationRowTargetAction,
): ConversationRowTargetResolution {
  const row = this["findRow"](target.rowId);
  if (!row || this["entityIdByRowId"].get(target.rowId) !== target.entityId) {
    return { ok: false, status: "stale", reasonCode: "proto.staleTarget" };
  }
  if (action === "editUserQuery") {
    const editTarget = this.resolveEditTargetByEntityId(target.entityId);
    if (row.actions?.canEdit !== true || !row.actions.editDisposition || !editTarget) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, editTarget };
  }
  if (action === "retryTurn") {
    const messageId = this["messageIdByRowId"].get(row.rowId);
    const userRow = this["snapshot"].rows.window.find(
      (candidate) =>
        candidate.turnId === row.turnId &&
        candidate.kind === "userInput" &&
        candidate.origin === "realUser",
    );
    const userEntityId = userRow ? this["entityIdByRowId"].get(userRow.rowId) : undefined;
    const editTarget = userEntityId ? this["editTargetByEntityId"].get(userEntityId) : undefined;
    if (row.actions?.canRetry !== true || !messageId || !editTarget) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, messageId, editTarget };
  }
  if (action === "forkAssistant") {
    const messageId = this["messageIdByRowId"].get(row.rowId);
    if (row.actions?.canFork !== true || !messageId) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, messageId };
  }
  if (action === "setAssistantFeedback") {
    const messageId = this["messageIdByRowId"].get(row.rowId);
    if (row.kind !== "assistantText" || !messageId) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, messageId };
  }
  if (action === "setHighspeedMetrics") {
    const messageId = this["messageIdByRowId"].get(row.rowId);
    if (row.kind !== "userInput" || !row.highspeed || !messageId) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, messageId };
  }
  if (row.kind !== "turnHeader") {
    return {
      ok: false,
      status: "rejected",
      reasonCode: "guard.actionUnavailable",
    };
  }
  if (
    (action === "applyFileRewind" || action === "fileRewindPreview") &&
    (!row.fileChanges || row.actions?.canRewindFiles !== true)
  ) {
    return {
      ok: false,
      status: "rejected",
      reasonCode: "guard.actionUnavailable",
    };
  }
  return {
    ok: true,
    action,
    row,
    messageIds: this.getMessageIdsForTurnRow(row.rowId),
  };
}

export function getMessageIdsForTurnRow(this: ProductProjection, rowId: number): string[] {
  const row = this["findRow"](rowId);
  if (!row) return [];
  const messageIds = new Set<string>();
  const runtimeTurnId = this["runtimeTurnIdByProductTurnId"].get(row.turnId);
  // Bug 原因：model-only turn 不生成可见 userInput row，过去只扫描 row 会漏掉
  // checkpoint 使用的隐藏 user messageId。新 turn 有持久消息时 productTurnId
  // 就是该 messageId；把它作为精确锚点后无需扩大 runtime turn 的兜底范围。
  if (runtimeTurnId && runtimeTurnId !== row.turnId) {
    messageIds.add(row.turnId);
  }
  for (const candidate of this["snapshot"].rows.window) {
    if (candidate.turnId !== row.turnId) continue;
    const messageId = this["messageIdByRowId"].get(candidate.rowId);
    if (messageId) messageIds.add(messageId);
  }
  for (const [messageId, continuationRowId] of this["outputContinuationRowIdByMessageId"]) {
    const continuationRow = this["findRow"](continuationRowId);
    if (continuationRow?.turnId === row.turnId) messageIds.add(messageId);
  }
  return [...messageIds];
}

export function isLatestAssistantSegmentRow(this: ProductProjection, rowId: number): boolean {
  const row = this["findRow"](rowId);
  if (row?.kind !== "assistantText") return false;
  for (let index = this["snapshot"].rows.window.length - 1; index >= 0; index -= 1) {
    const candidate = this["snapshot"].rows.window[index]!;
    if (candidate.kind === "assistantText" && candidate.turnId === row.turnId) {
      return candidate.rowId === rowId;
    }
  }
  return false;
}
