import { z } from "zod";
import {
  imageGenerationInputSchema,
  generatedImageSchema,
  type ImageGenerationJob,
} from "@zcode/shared";
import type { ToolEntry, ToolHandler } from "../types.js";
import {
  cancelImageJob,
  finishImageJob,
  imageRequest,
  interruptImageJob,
  prepareImageReferences,
  readImageJobs,
  saveImageJob,
  withImageJobLock,
} from "./image-generation-job.js";

const TOOL_TIMEOUT_MS = 15 * 60 * 1000;
const OUTPUT_BYTES = 32 * 1024;
const manageInput = z
  .object({
    action: z.enum(["list", "resume", "cancel"]),
    generationId: z.string().min(1).optional(),
  })
  .strict();
const outputSchema = z.object({
  generationId: z.string(),
  state: z.string(),
  images: z.array(generatedImageSchema),
  message: z.string().optional(),
});
const summarize = (job: ImageGenerationJob, message?: string) => ({
  generationId: job.generationId,
  state: job.state,
  images: job.images,
  ...(message ? { message } : {}),
});

export const generateImageHandler: ToolHandler = async (raw, context) => {
  const input = imageGenerationInputSchema.parse(raw),
    port = context.imageGenerationPort;
  if (!port?.config.enabled)
    throw new Error("Enable image generation in Settings and start a new session.");
  if (context.runtimeScope === "subagent" && !port.config.allowSubagents)
    throw new Error("Image generation is disabled for subagents.");
  const generationId = `image:${context.sessionId}:${context.toolCallId}`;
  return withImageJobLock(context, generationId, async (context) => {
    const prior = (await readImageJobs(context)).find((job) => job.generationId === generationId);
    if (prior) {
      if (JSON.stringify(prior.input) !== JSON.stringify(input))
        throw new Error("An image call ID cannot be reused with different parameters.");
      return summarize(await finishImageJob(context, prior));
    }
    if (!context.artifactStore?.writeToolResultBinaryArtifact)
      throw new Error("Image artifact storage unavailable.");
    const references = await prepareImageReferences(context, input.referenceImages);
    context.abortSignal.throwIfAborted();
    const job: ImageGenerationJob = {
      generationId,
      sessionId: context.sessionId,
      input,
      state: "submitting",
      images: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    // 先持久化意图再提交；中断后没有 request_id 的意图必须保持 unknown，不能重复付费。
    await saveImageJob(context, job);
    try {
      context.abortSignal.throwIfAborted();
      const response = await imageRequest(context, {
        type: "submit",
        config: port.config,
        input,
        references,
      });
      if (response.type === "rejected") {
        job.state = "failed";
        job.error = response.message;
        throw new Error(response.message);
      }
      if (response.type !== "submitted") throw new Error("Invalid image submission response.");
      job.ticket = response.ticket;
      job.state = "submitted";
      await saveImageJob(context, job);
    } catch (error) {
      if (job.state !== "failed") {
        job.state = job.ticket ? "submitted" : "unknown";
        job.error = "Submission could not be confirmed. Do not submit again automatically.";
      }
      await saveImageJob(context, job);
      if (job.ticket && context.abortSignal.aborted)
        await cancelImageJob(context, job).catch(() => {});
      throw new Error(
        `${error instanceof Error ? error.message : job.error} Generation ID: ${generationId}. Inspect with ManageImageGeneration.`,
        { cause: error },
      );
    }
    return summarize(await finishImageJob(context, job));
  });
};
export const manageImageGenerationHandler: ToolHandler = async (raw, context) => {
  const input = manageInput.parse(raw);
  if (input.action === "list")
    return { jobs: (await readImageJobs(context)).map((job) => summarize(job, job.error)) };
  if (!input.generationId) throw new Error("generationId is required.");
  if (input.action === "cancel") {
    const job = (await readImageJobs(context)).find(
      (item) => item.generationId === input.generationId,
    );
    if (!job) throw new Error("Image generation does not belong to this session.");
    // 取消不能排在生成锁后面等生成结束；唤醒执行所有者，由它收口 checkpoint 和远端取消。
    if (interruptImageJob(context, input.generationId))
      return summarize(
        { ...job, state: "cancel_requested" },
        "Cancellation requested. The provider may still complete running work.",
      );
    return summarize(job, await cancelImageJob(context, job));
  }
  return withImageJobLock(context, input.generationId, async (context) => {
    const job = (await readImageJobs(context)).find(
      (item) => item.generationId === input.generationId,
    );
    if (!job) throw new Error("Image generation does not belong to this session.");
    return summarize(await finishImageJob(context, job));
  });
};
function entry(
  name: string,
  description: string,
  handler: ToolHandler,
  schema: z.ZodType,
): ToolEntry {
  return {
    capability: description,
    metadata: {
      name,
      description,
      readOnly: false,
      destructive: false,
      concurrentSafe: true,
      timeoutMs: TOOL_TIMEOUT_MS,
      maxOutputBytes: OUTPUT_BYTES,
      sideEffectScope: "network",
      riskLevel: "low",
      needsApproval: false,
      modelInstructions: [
        "Use GenerateImage when the user requests image generation or image editing and this tool is available.",
        "Honor explicit pixel dimensions, image count and output format exactly. Default to one PNG. Do not substitute an unsupported model, size or format.",
        "Use referenceImages for editing: authorized workspace files or current-session zcode-artifact URIs. Never upload unrelated repository content.",
        "Generation can take several minutes. Wait for completion; the UI shows loading and then images. Do not create extra variants unless requested.",
        "On interruption or submission unknown, use ManageImageGeneration list/resume with the existing generationId. Never resubmit automatically. Resume after user stop only when requested.",
        "Images are already displayed in the tool result. Mention their completion without duplicating the gallery. Use existing file tools if the user requests a project copy.",
      ],
    },
    handler,
    inputSchema: z.toJSONSchema(schema),
    runtimeInputSchema: schema,
    outputSchema: z.toJSONSchema(
      z.union([outputSchema, z.object({ jobs: z.array(outputSchema) })]),
    ),
    runtimeOutputSchema: z.union([outputSchema, z.object({ jobs: z.array(outputSchema) })]),
    formatModelContent: (output) => JSON.stringify(output),
    permission: {
      permission: "image.generate",
      reason: "Use the configured image provider",
      riskLevel: "low",
      sideEffectScope: "network",
      needsApproval: false,
      patternSources: ["toolName", "input"],
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: OUTPUT_BYTES,
      maxModelBytes: OUTPUT_BYTES,
      strategy: "truncate",
      preview: { maxBytes: OUTPUT_BYTES, direction: "head" },
    },
    timeout: { defaultMs: TOOL_TIMEOUT_MS, maxMs: TOOL_TIMEOUT_MS, allowCallOverride: false },
    cancellation: {
      supported: true,
      cleanup: "none",
      userVisibleMessage:
        "Image generation stopped; remote cancellation is best effort. Existing requests can be recovered without generating again.",
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}
export const generateImageToolEntry = entry(
  "GenerateImage",
  "Generate or edit images using the configured image service. Preserves requested dimensions, count and format (default PNG).",
  generateImageHandler,
  imageGenerationInputSchema,
);
export const manageImageGenerationToolEntry = entry(
  "ManageImageGeneration",
  "List, recover or cancel image generations belonging to this session without submitting a new paid request.",
  manageImageGenerationHandler,
  manageInput,
);
