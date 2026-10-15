// Modified by ZCode Feiyu.
import { z } from "zod";

/** 未完成原因只允许有界机器码；不得把原始响应或凭据带入公共错误。 */
export const subscriptionIncompleteReasonSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u);

export function safeSubscriptionIncompleteReason(value: unknown): string | undefined {
  const result = subscriptionIncompleteReasonSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
