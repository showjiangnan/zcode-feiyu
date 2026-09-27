import { z } from "zod";
import { IMAGE_MAX_BYTES, IMAGE_MAX_COUNT } from "@zcode/shared";

// contracts 仍使用 Zod 3；不能把 shared 的 Zod 4 实例塞进本地 discriminatedUnion。
// 两侧结构由协议往返测试保持一致，字段预算共用 shared 常量。
export const imageGenerationDisplaySchema = z
  .object({
    kind: z.literal("image_generation"),
    generationId: z.string().min(1),
    images: z
      .array(
        z
          .object({
            ref: z.string().min(1),
            fileName: z.string().min(1),
            mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
            bytes: z.number().int().positive().max(IMAGE_MAX_BYTES),
            width: z.number().int().positive().optional(),
            height: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .max(IMAGE_MAX_COUNT),
    message: z.string().max(2000).optional(),
  })
  .strict();
