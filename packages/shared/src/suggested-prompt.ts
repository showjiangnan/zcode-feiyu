// Modified by ZCode Feiyu.
import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";

export const SUGGESTED_PROMPT_MAX_CHARS = 600;
export const SUGGESTED_PROMPT_ENTRY_TYPE = "runtime/suggested_prompt";

/** 开关只开放能力；会话许可独立，不能从全局设置推导。 */
export const suggestedPromptSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    modelSelection: modelSelectionSchema.optional(),
  })
  .strict();
export type SuggestedPromptSettings = z.infer<typeof suggestedPromptSettingsSchema>;

export const suggestedPromptStateSchema = z
  .object({
    enabled: z.boolean(),
    available: z.boolean(),
    revision: z.number().int().nonnegative(),
    phase: z.enum(["off", "waiting", "generating", "ready", "failed"]),
    sourceTurnId: z.string().min(1).optional(),
    suggestion: z.string().trim().min(1).max(SUGGESTED_PROMPT_MAX_CHARS).optional(),
  })
  .strict();
export type SuggestedPromptState = z.infer<typeof suggestedPromptStateSchema>;

export const suggestedPromptOutputSchema = z
  .object({
    suggestion: z.string().trim().min(1).max(SUGGESTED_PROMPT_MAX_CHARS).nullable(),
  })
  .strict();

export const suggestedPromptConsentSchema = z.object({ enabled: z.boolean() }).strict();
