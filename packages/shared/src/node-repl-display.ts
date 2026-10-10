// Modified by ZCode Feiyu contributors (2026).
import { z } from "zod";

// 共享的是 UI 有界投影；原始 CUA PNG 的独立模型载荷上限不由这个展示预算决定。
export const NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES = 200 * 1024;
export const nodeReplCuaAppDisplaySchema = z
  .object({
    appKey: z.string().trim().min(1).max(2_048),
    displayName: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export const nodeReplImageDisplaySchema = z
  .object({
    kind: z.literal("node_repl_images"),
    images: z
      .array(
        z
          .object({
            base64: z.string().min(1).max(NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES),
            mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/iu),
          })
          .strict(),
      )
      .min(1)
      .max(2)
      .optional(),
    app: nodeReplCuaAppDisplaySchema.optional(),
    truncated: z.boolean().optional(),
    source: z.literal("browser_turn_end").optional(),
  })
  .strict();
