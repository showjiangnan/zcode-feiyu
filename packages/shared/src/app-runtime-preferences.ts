// Modified by ZCode Feiyu contributors (2026).
import { z } from "zod";
import { continuityPolicySchema } from "./continuity-policy.js";

export const APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL = "settings:app-runtime-preferences";
export const ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV = "ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE";

export const appRuntimePreferencesChangedBroadcastPayloadSchema = z
  .object({
    policyRevision: z.number().int().nonnegative().default(0),
    askUserQuestionAutoResolutionEnabled: z.boolean(),
    modelIoFullRetentionEnabled: z.boolean().default(false),
    telemetryReportingEnabled: z.boolean().optional(),
    memoryEnabled: z.boolean().optional(),
    memoryExtractionEnabled: z.boolean().optional(),
    memoryReviewEnabled: z.boolean().optional(),
    continuityPolicy: continuityPolicySchema.optional(),
    continueAfterCloseOnMac: z.boolean().optional(),
  })
  .strict();

export type AppRuntimePreferencesChangedBroadcastPayload = z.infer<
  typeof appRuntimePreferencesChangedBroadcastPayloadSchema
>;

/** policyRevision 是完整应用的实际版本；缺少证明的旧端只能返回 unconfirmed。 */
export const runtimePolicyAcknowledgementSchema = z
  .object({
    policyRevision: z.number().int().nonnegative().optional(),
    status: z.enum(["applied", "superseded", "failed", "unconfirmed"]),
    error: z.string().optional(),
  })
  .strict();
export type RuntimePolicyAcknowledgement = z.infer<typeof runtimePolicyAcknowledgementSchema>;

export const broadcastDeliveryReceiptSchema = runtimePolicyAcknowledgementSchema.extend({
  /** -1 为 Main 原生出口；其他值为目标 Host 的 webContents id。 */
  windowId: z.number().int(),
});
export type BroadcastDeliveryReceipt = z.infer<typeof broadcastDeliveryReceiptSchema>;
export interface BroadcastDeliverySummary {
  targetCount: number;
  failedCount: number;
  receipts?: BroadcastDeliveryReceipt[];
}
