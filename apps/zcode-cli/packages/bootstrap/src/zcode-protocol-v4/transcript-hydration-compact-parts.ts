// Modified by ZCode Feiyu.
import type { MessagePart, MessageWithParts } from "@zcode/contracts";

/** 冷恢复在发出 compact 事实之前收集 durable 边界，保留同操作最新的完整 tail。 */
export function collectDurableCompactParts(
  messages: readonly MessageWithParts[],
): Map<string, Extract<MessagePart, { type: "compaction" }>> {
  const durableCompactPartsByOperation = new Map<
    string,
    Extract<MessagePart, { type: "compaction" }>
  >();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "compaction") continue;
      if (!part.timelineStatus && !part.tail_start_id && !part.compactBoundary) continue;
      const operationId = String(
        part.operationId ?? part.boundaryId ?? `legacy-compact-${String(part.id)}`,
      );
      const existing = durableCompactPartsByOperation.get(operationId);
      if (!existing || (!existing.tail_start_id && part.tail_start_id)) {
        durableCompactPartsByOperation.set(operationId, part);
      }
    }
  }
  return durableCompactPartsByOperation;
}
