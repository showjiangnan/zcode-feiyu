// Modified by ZCode Feiyu.
import type { SessionEvent } from "@zcode/contracts";
import type { SubagentRow } from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjection } from "./product-projection.js";

export function findSubagentLifecycleRow(
  this: ProductProjection,
  agentId: string,
  payload: Record<string, unknown>,
  event: SessionEvent,
): SubagentRow | undefined {
  const exact = this["findSubagentRow"](agentId);
  if (exact) return exact;
  const parentToolCallId = this["stringPayload"](payload, "parentToolCallId");
  if (!parentToolCallId) return undefined;
  const turnId = this["turnIdOf"](event);
  // 晚订阅 hydration 无法从后台 Agent 的文本 tool output 恢复真实 agentId，
  // 会先用 toolCallId 合成一条 SubagentRow。后到的 live lifecycle 携带真实 agentId，
  // 旧逻辑因此追加第二行，UI 又会让无 childSessionId 的合成行抢占配对。父 tool call
  // 在同一 turn 内是稳定唯一身份，这里将真实事件归并回合成行并补齐 childSessionId。
  return this["snapshot"].rows.window.find(
    (row): row is SubagentRow =>
      row.kind === "subagent" && row.turnId === turnId && row.parentToolCallId === parentToolCallId,
  );
}

export function subagentAgentId(
  this: ProductProjection,
  payload: Record<string, unknown>,
  event: SessionEvent,
): string {
  return (
    this["stringPayload"](payload, "agentId") ??
    this["stringPayload"](payload, "childSessionId") ??
    this["stringPayload"](payload, "parentToolCallId") ??
    `subagent-${event.sequenceNumber}`
  );
}

export function stringPayload(
  this: ProductProjection,
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function mapSubagentStatus(
  this: ProductProjection,
  status: string | undefined,
): SubagentRow["status"] {
  switch (status) {
    case "completed":
    case "success":
      return "success";
    case "cancelled":
    case "stopped":
      return "cancelled";
    default:
      return "failed";
  }
}
