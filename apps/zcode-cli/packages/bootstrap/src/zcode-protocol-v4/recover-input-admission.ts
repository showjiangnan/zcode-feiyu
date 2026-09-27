import type { MessageWithParts } from "@zcode/contracts";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";

/** 冷恢复以前只记 accepted，任务重试会因缺少 inputAccepted 被误报失败。 */
export function recoverInputAdmission(message: MessageWithParts): CommandAck["result"] {
  if (message.info.role !== "user") return undefined;
  const commandId = message.info.anchor?.sourceCommandId;
  const value = message.info.metadata?.conversationInputIntent;
  if (!commandId || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const intent = value as Record<string, unknown>;
  if (intent.sourceCommandId !== commandId) return undefined;
  const raw = intent.delivery;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { admitted, fallbackReasonCode } = raw as Record<string, unknown>;
  if (admitted !== "startNow" && admitted !== "guide" && admitted !== "queue") return undefined;
  const targetTurnId = message.info.anchor?.productTurnId ?? message.info.anchor?.turnId;
  return {
    type: "inputAccepted",
    inputId: commandId,
    delivery: admitted,
    ...(targetTurnId ? { targetTurnId } : {}),
    ...(typeof fallbackReasonCode === "string" ? { fallbackReasonCode } : {}),
  };
}
