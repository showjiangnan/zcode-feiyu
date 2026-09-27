import type {
  CommandAck,
  CommandExecution,
  ConversationRow,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";

/** 执行观察完全派生自 CLI 投影；Host 不能把 ACK 或 task index 的 busy 当成完成事实。 */
export function observeCommandExecution(
  commandId: string,
  ack: CommandAck | "unknown",
  snapshot: ConversationSnapshot,
  rows: readonly ConversationRow[],
): CommandExecution {
  if (ack !== "unknown" && ack.reasonCode === "fault.command.queryUnavailable")
    return { state: "unknown", reasonCode: ack.reasonCode };
  if (ack !== "unknown" && ["failed", "rejected", "stale"].includes(ack.status)) {
    return {
      state: ack.reasonCode?.includes("Cancelled") ? "cancelled" : "failed",
      reasonCode: ack.reasonCode,
    };
  }
  if (snapshot.queue.items.some((item) => item.sourceCommandId === commandId))
    return { state: "queued" };
  const input = rows.find((row) => row.kind === "userInput" && row.sourceCommandId === commandId);
  const accepted =
    ack !== "unknown" && ack.result?.type === "inputAccepted" ? ack.result : undefined;
  const targetTurnId = input?.productTurnId ?? input?.turnId ?? accepted?.targetTurnId;
  if (!targetTurnId) return { state: "unknown" };
  const header = rows.find(
    (row) => row.kind === "turnHeader" && (row.productTurnId ?? row.turnId) === targetTurnId,
  );
  if (!header || header.kind !== "turnHeader") return { state: "unknown", targetTurnId };
  const states = {
    running: "running",
    completedSuccess: "succeeded",
    completedInterrupted: "interrupted",
    failed: "failed",
  } as const;
  return { state: states[header.state], targetTurnId };
}
