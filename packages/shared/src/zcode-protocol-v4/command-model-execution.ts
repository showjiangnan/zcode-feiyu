// Modified by ZCode Feiyu.
import { z } from "zod";

// sendText / editUserQuery / sendQueuedNow 共用的执行材料不变量：modelExecution 只能依附
// 本次 modelSelection，禁止在缺 Selection 时单独补供凭据（历史消息 rewind 后不复用旧凭据）。
export function requireModelSelectionForExecution(
  payload: { modelSelection?: unknown; modelExecution?: unknown },
  context: z.RefinementCtx,
): void {
  if (payload.modelExecution && !payload.modelSelection) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "modelExecution requires modelSelection",
      path: ["modelExecution"],
    });
  }
}
