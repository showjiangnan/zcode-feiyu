// Modified by ZCode Feiyu contributors (2026).
import type { SendInputResult } from "../../../app/types.js";
import type { CommandResult } from "@zcode/shared/zcode-protocol-v4";

/** 命令回执来自 Core admission，不能把所有 queued 结果都当成未来轮次。 */
export function resolvePromptAdmissionResult(
  admission: SendInputResult,
): Pick<
  Extract<CommandResult, { type: "inputAccepted" }>,
  "delivery" | "targetTurnId" | "fallbackReasonCode"
> {
  if (admission.kind === "queued")
    return {
      delivery: admission.delivery,
      ...(admission.delivery === "guide" ? { targetTurnId: admission.turnId } : {}),
      ...(admission.fallbackReasonCode ? { fallbackReasonCode: admission.fallbackReasonCode } : {}),
    };
  if (admission.kind === "started_turn")
    return { delivery: "startNow", targetTurnId: admission.turnId };
  throw new Error(`Cannot acknowledge rejected input: ${admission.reason}`);
}
