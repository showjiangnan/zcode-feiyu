// Modified by ZCode Feiyu.
import type { SessionEvent } from "@zcode/contracts";
import type {
  ConversationDelta,
  SubagentRow,
  BackgroundWorkSummary,
} from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjection } from "./product-projection.js";

export function onSubagentSpawned(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as Record<string, unknown>;
  const agentId = this["subagentAgentId"](payload, event);
  const existing = this["findSubagentLifecycleRow"](agentId, payload, event);
  if (existing) this["subagentRowIdByAgentId"].set(agentId, existing.rowId);
  const childSessionId = this["stringPayload"](payload, "childSessionId");
  const parentToolCallId = this["stringPayload"](payload, "parentToolCallId");
  const resumedBackgroundWork = this["resumedSubagentBackgroundWorkDelta"](
    event,
    payload,
    agentId,
    childSessionId,
  );
  if (
    existing?.status === "running" &&
    (!childSessionId || childSessionId === existing.childSessionId) &&
    (!parentToolCallId || parentToolCallId === existing.parentToolCallId) &&
    (payload.background !== true || existing.backgrounded === true)
  ) {
    return resumedBackgroundWork ? [resumedBackgroundWork] : [];
  }
  if (existing) {
    const row: SubagentRow = {
      ...existing,
      status: "running",
      summaryText:
        this["stringPayload"](payload, "description") ??
        this["stringPayload"](payload, "prompt") ??
        existing.summaryText,
      // resume 事件携带的是 SendMessage call id，但 parentToolCallId 是 row 的创建锚点；
      // 已存在的锚点不能作为生命周期字段被覆盖，否则 UI 无法再关联原 Agent 行。
      ...(!existing.parentToolCallId && parentToolCallId ? { parentToolCallId } : {}),
      ...(childSessionId ? { childSessionId } : {}),
      ...(payload.background === true ? { backgrounded: true as const } : {}),
      ...(payload.background === true ? { workId: agentId } : {}),
      startedAt: this["ms"](event),
    };
    delete row.endedAt;
    return [{ op: "row.upserted", row }, ...(resumedBackgroundWork ? [resumedBackgroundWork] : [])];
  }
  const row: SubagentRow = {
    ...this["rowBase"](event, this["turnIdOf"](event), agentId),
    kind: "subagent",
    ...(this["stringPayload"](payload, "parentToolCallId")
      ? { parentToolCallId: this["stringPayload"](payload, "parentToolCallId") }
      : {}),
    subagentType: this["stringPayload"](payload, "agentType") ?? "subagent",
    status: "running",
    summaryText:
      this["stringPayload"](payload, "description") ??
      this["stringPayload"](payload, "summaryText") ??
      this["stringPayload"](payload, "prompt") ??
      "",
    ...(this["stringPayload"](payload, "childSessionId")
      ? { childSessionId: this["stringPayload"](payload, "childSessionId") }
      : {}),
    ...(payload.background === true ? { backgrounded: true as const } : {}),
    ...(payload.background === true ? { workId: agentId } : {}),
    startedAt: this["ms"](event),
  };
  this["subagentRowIdByAgentId"].set(agentId, row.rowId);
  return [{ op: "row.appended", row }, ...(resumedBackgroundWork ? [resumedBackgroundWork] : [])];
}

export function resumedSubagentBackgroundWorkDelta(
  this: ProductProjection,
  event: SessionEvent,
  payload: Record<string, unknown>,
  agentId: string,
  childSessionId: string | undefined,
): ConversationDelta | undefined {
  if (payload.background !== true || payload.resumed !== true || !childSessionId) {
    return undefined;
  }
  // SendMessage resume 直接进入 subagent port，不经过 Agent tool executor，
  // 因而不会产生 tracker 的 BackgroundTaskStarted。SubagentSpawned 已是单一启动事实，
  // 这里在同一次 V4 transaction 内补齐可取消 work，避免再引入第二个可失败事件。
  const previous = this["snapshot"].backgroundWorks;
  const existing = previous.find((work) => work.workId === agentId);
  const title =
    this["stringPayload"](payload, "description") ??
    this["stringPayload"](payload, "prompt") ??
    existing?.title ??
    agentId;
  if (
    existing?.status === "running" &&
    existing.kind === "subagent" &&
    existing.title === title &&
    existing.childSessionId === childSessionId &&
    existing.cancellable === true
  ) {
    return undefined;
  }
  const next: BackgroundWorkSummary = {
    workId: agentId,
    kind: "subagent",
    title,
    status: "running",
    startedAt: this["ms"](event),
    cancellable: true,
    anchorRowId: existing?.anchorRowId ?? null,
    childSessionId,
  };
  const backgroundWorks = existing
    ? previous.map((work) => (work.workId === agentId ? next : work))
    : [...previous, next];
  return { op: "state.updated", patch: { backgroundWorks } };
}

export function onSubagentMessage(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as Record<string, unknown>;
  const row = this["findSubagentRow"](this["subagentAgentId"](payload, event));
  const append =
    this["stringPayload"](payload, "summaryText") ??
    this["stringPayload"](payload, "text") ??
    this["stringPayload"](payload, "message");
  if (!row || !append) return [];
  return [{ op: "row.delta", rowId: row.rowId, path: "summaryText", append }];
}

export function onSubagentStopped(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as Record<string, unknown>;
  const agentId = this["subagentAgentId"](payload, event);
  const existing = this["findSubagentLifecycleRow"](agentId, payload, event);
  const parentToolCallId = this["stringPayload"](payload, "parentToolCallId");
  const status = this["mapSubagentStatus"](this["stringPayload"](payload, "status"));
  const summaryText =
    this["stringPayload"](payload, "summaryText") ??
    this["stringPayload"](payload, "result") ??
    this["stringPayload"](payload, "error") ??
    this["stringPayload"](payload, "description") ??
    existing?.summaryText ??
    "";
  const row: SubagentRow = existing
    ? {
        ...existing,
        status,
        summaryText,
        endedAt: this["ms"](event),
        // resumed child 的终态同样属于原 Agent row，只在旧 row 缺失锚点时补齐。
        ...(!existing.parentToolCallId && parentToolCallId ? { parentToolCallId } : {}),
        ...(this["stringPayload"](payload, "childSessionId")
          ? { childSessionId: this["stringPayload"](payload, "childSessionId") }
          : {}),
      }
    : {
        ...this["rowBase"](event, this["turnIdOf"](event), agentId),
        kind: "subagent",
        ...(this["stringPayload"](payload, "parentToolCallId")
          ? {
              parentToolCallId: this["stringPayload"](payload, "parentToolCallId"),
            }
          : {}),
        subagentType: this["stringPayload"](payload, "agentType") ?? "subagent",
        status,
        summaryText,
        ...(this["stringPayload"](payload, "childSessionId")
          ? { childSessionId: this["stringPayload"](payload, "childSessionId") }
          : {}),
        ...(payload.background === true ? { backgrounded: true as const } : {}),
        ...(payload.background === true ? { workId: agentId } : {}),
        endedAt: this["ms"](event),
      };
  this["subagentRowIdByAgentId"].set(agentId, row.rowId);
  return [{ op: existing ? "row.upserted" : "row.appended", row }];
}
