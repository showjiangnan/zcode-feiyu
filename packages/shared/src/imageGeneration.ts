// Modified by ZCode Feiyu contributors (2026).
import { z } from "zod";

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_CHUNK_BYTES = 256 * 1024;
export const IMAGE_MAX_COUNT = 8;
export const IMAGE_SETTINGS_CHANGED_CHANNEL = "image-generation:settings-changed";
export const imageFormatSchema = z.enum(["png", "jpeg", "webp"]);
const endpointSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/)
  .max(240);
export const imageGenerationConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    allowSubagents: z.boolean().default(false),
    apiUrl: z.string().url().default("https://queue.fal.run"),
    model: endpointSchema.default("fal-ai/flux/schnell"),
    editModel: endpointSchema.optional(),
  })
  .strict();
export type ImageGenerationConfig = z.infer<typeof imageGenerationConfigSchema>;
export const imageGenerationInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(16_000),
    width: z.number().int().min(64).max(8192).optional(),
    height: z.number().int().min(64).max(8192).optional(),
    count: z.number().int().min(1).max(IMAGE_MAX_COUNT).default(1),
    format: imageFormatSchema.default("png"),
    referenceImages: z.array(z.string().min(1).max(4096)).max(4).default([]),
  })
  .strict()
  .refine((value) => (value.width === undefined) === (value.height === undefined), {
    message: "Specify both width and height.",
  });
export type ImageGenerationInput = z.infer<typeof imageGenerationInputSchema>;
export const generatedImageSchema = z
  .object({
    ref: z.string().min(1),
    fileName: z.string().min(1),
    mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
    bytes: z.number().int().positive().max(IMAGE_MAX_BYTES),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .strict();
export type GeneratedImage = z.infer<typeof generatedImageSchema>;
export const imageGenerationDisplaySchema = z
  .object({
    kind: z.literal("image_generation"),
    generationId: z.string().min(1),
    images: z.array(generatedImageSchema).max(IMAGE_MAX_COUNT),
    message: z.string().max(2000).optional(),
  })
  .strict();
export const imageGenerationTicketSchema = z
  .object({
    requestId: z.string().min(1).max(256),
    apiUrl: z.string().url(),
    endpoint: endpointSchema,
    statusUrl: z.string().url(),
    responseUrl: z.string().url(),
    cancelUrl: z.string().url(),
  })
  .strict();
export type ImageGenerationTicket = z.infer<typeof imageGenerationTicketSchema>;
export const imageGenerationOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("config") }).strict(),
  z
    .object({
      type: z.literal("submit"),
      config: imageGenerationConfigSchema,
      input: imageGenerationInputSchema,
      references: z.array(z.string().max(4 * 1024 * 1024 + 128)).max(4),
    })
    .strict(),
  z.object({ type: z.literal("status"), ticket: imageGenerationTicketSchema }).strict(),
  z.object({ type: z.literal("cancel"), ticket: imageGenerationTicketSchema }).strict(),
  z
    .object({
      type: z.literal("download"),
      ticket: imageGenerationTicketSchema,
      index: z
        .number()
        .int()
        .min(0)
        .max(IMAGE_MAX_COUNT - 1),
      offset: z.number().int().min(0).max(IMAGE_MAX_BYTES),
    })
    .strict(),
]);
export const imageGenerationRequestSchema = z
  .object({
    sourceSessionId: z.string().min(1),
    childSession: z.boolean(),
    traceId: z.string().min(1),
    operation: imageGenerationOperationSchema,
  })
  .strict();
export type ImageGenerationRequest = z.infer<typeof imageGenerationRequestSchema>;
export const imageGenerationResponseSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("config"),
      config: imageGenerationConfigSchema,
      hasCredential: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("submitted"), ticket: imageGenerationTicketSchema }).strict(),
  z.object({ type: z.literal("rejected"), message: z.string().max(2000) }).strict(),
  z
    .object({
      type: z.literal("status"),
      status: z.enum(["queued", "running", "completed"]),
      imageCount: z.number().int().min(1).max(IMAGE_MAX_COUNT).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("cancelled"),
      disposition: z.enum(["requested", "already_completed", "not_found"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("chunk"),
      data: z.string().max(IMAGE_CHUNK_BYTES * 2),
      nextOffset: z.number().int().nonnegative().nullable(),
      mime: generatedImageSchema.shape.mime,
      totalBytes: generatedImageSchema.shape.bytes,
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type ImageGenerationResponse = z.infer<typeof imageGenerationResponseSchema>;
export const imageGenerationJobSchema = z
  .object({
    generationId: z.string(),
    sessionId: z.string(),
    input: imageGenerationInputSchema,
    state: z.enum([
      "submitting",
      "submitted",
      "unknown",
      "completed",
      "cancel_requested",
      "failed",
    ]),
    ticket: imageGenerationTicketSchema.optional(),
    images: z.array(generatedImageSchema),
    createdAt: z.number(),
    updatedAt: z.number(),
    error: z.string().optional(),
  })
  .strict();
export type ImageGenerationJob = z.infer<typeof imageGenerationJobSchema>;
