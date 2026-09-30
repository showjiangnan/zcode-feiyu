// Modified by ZCode Feiyu contributors (2026).
import {
  imageGenerationJobSchema,
  IMAGE_MAX_BYTES,
  type ImageGenerationJob,
  type ImageGenerationRequest,
} from "@zcode/shared";
import type { ToolExecutionContext } from "../types.js";

export const IMAGE_JOB_ENTRY = "image_generation/job";
const POLL_INTERVAL_MS = 2000;
const POLL_LIMIT = 420;
const MAX_REFERENCE_BYTES = 3 * 1024 * 1024;
const locks = new WeakMap<object, Map<string, Promise<unknown>>>();
const activeJobs = new WeakMap<object, Map<string, AbortController>>();

export async function withImageJobLock<T>(
  context: ToolExecutionContext,
  id: string,
  action: (boundContext: ToolExecutionContext) => Promise<T>,
): Promise<T> {
  if (!context.sessionStore) throw new Error("Image generation requires durable session storage.");
  let jobs = locks.get(context.sessionStore);
  if (!jobs) {
    jobs = new Map();
    locks.set(context.sessionStore, jobs);
  }
  const prior = jobs.get(id);
  const controller = new AbortController();
  let controllers = activeJobs.get(context.sessionStore);
  if (!controllers) {
    controllers = new Map();
    activeJobs.set(context.sessionStore, controllers);
  }
  const next = (async () => {
    await prior?.catch(() => {});
    context.abortSignal.throwIfAborted();
    controllers.set(id, controller);
    return action({
      ...context,
      abortSignal: AbortSignal.any([context.abortSignal, controller.signal]),
    });
  })();
  jobs.set(id, next);
  try {
    return await next;
  } finally {
    if (jobs.get(id) === next) jobs.delete(id);
    if (controllers.get(id) === controller) controllers.delete(id);
  }
}
export function interruptImageJob(context: ToolExecutionContext, id: string): boolean {
  const controller = context.sessionStore && activeJobs.get(context.sessionStore)?.get(id);
  if (!controller) return false;
  controller.abort(new Error("Image generation cancelled."));
  return true;
}
export async function readImageJobs(context: ToolExecutionContext): Promise<ImageGenerationJob[]> {
  if (!context.sessionStore?.sessionEntries || !context.sessionStore.saveSessionEntry)
    throw new Error("Image generation requires durable session storage.");
  return (
    await context.sessionStore.sessionEntries({
      sessionID: context.sessionId,
      type: IMAGE_JOB_ENTRY,
    })
  )
    .map((entry) => imageGenerationJobSchema.safeParse(entry.data))
    .flatMap((parsed) =>
      parsed.success && parsed.data.sessionId === context.sessionId ? [parsed.data] : [],
    );
}
export async function saveImageJob(
  context: ToolExecutionContext,
  job: ImageGenerationJob,
): Promise<void> {
  if (!context.sessionStore?.saveSessionEntry)
    throw new Error("Image checkpoint storage unavailable.");
  job.updatedAt = Date.now();
  await context.sessionStore.saveSessionEntry({
    id: job.generationId,
    sessionID: context.sessionId,
    type: IMAGE_JOB_ENTRY,
    touchSession: false,
    time: { created: job.createdAt, updated: job.updatedAt },
    data: imageGenerationJobSchema.parse(job),
  });
}
export function imageRequest(
  context: ToolExecutionContext,
  operation: ImageGenerationRequest["operation"],
) {
  if (!context.imageGenerationPort)
    throw new Error("Image generation is unavailable on this Host.");
  return context.imageGenerationPort.request({
    sourceSessionId: context.sessionId,
    traceId: context.traceId,
    childSession: context.runtimeScope === "subagent",
    operation,
  });
}
export async function prepareImageReferences(context: ToolExecutionContext, paths: string[]) {
  const references: string[] = [];
  for (const path of paths) {
    context.abortSignal.throwIfAborted();
    if (path.startsWith("zcode-artifact://")) {
      const ownPrefix = `zcode-artifact://${encodeURIComponent(context.sessionId)}/`;
      if (!path.startsWith(ownPrefix))
        throw new Error("Reference image belongs to another session.");
      const stat = await context.artifactStore?.statToolResultArtifact?.({
        uri: path,
        trace: context.traceContext,
      });
      if (!stat) throw new Error("Reference image is unavailable.");
      if (
        stat.contentType === "text/plain" &&
        stat.bytes <= Math.ceil((MAX_REFERENCE_BYTES * 4) / 3) + 128
      ) {
        const artifact = await context.artifactStore!.readToolResultArtifact({
          uri: path,
          trace: context.traceContext,
        });
        const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/u.exec(
          artifact.content,
        );
        if (!match || Buffer.byteLength(match[2]!, "base64") > MAX_REFERENCE_BYTES)
          throw new Error("Reference image must be PNG, JPEG or WebP of at most 3 MiB.");
        references.push(artifact.content);
        continue;
      }
      if (stat.bytes > MAX_REFERENCE_BYTES) throw new Error("Reference image exceeds 3 MiB.");
      const read = await context.artifactStore?.readToolResultBinaryArtifact?.({
        uri: path,
        trace: context.traceContext,
      });
      if (
        !read ||
        read.bytes.length > MAX_REFERENCE_BYTES ||
        !["image/png", "image/jpeg", "image/webp"].includes(read.contentType)
      )
        throw new Error("Reference image must be PNG, JPEG or WebP of at most 3 MiB.");
      references.push(
        `data:${read.contentType};base64,${Buffer.from(read.bytes).toString("base64")}`,
      );
    } else {
      if (!context.imageGenerationPort?.readReference)
        throw new Error("Workspace image references are unavailable.");
      references.push(
        await context.imageGenerationPort.readReference(
          { path, workspaceRoot: context.workspaceRoot },
          context.abortSignal,
        ),
      );
    }
  }
  return references;
}
export async function cancelImageJob(context: ToolExecutionContext, job: ImageGenerationJob) {
  if (job.state === "completed") return "This generation is already completed and saved locally.";
  if (!job.ticket)
    return "Submission is unknown; no provider request ID is available. Do not resubmit automatically.";
  job.state = "cancel_requested";
  await saveImageJob(context, job);
  const result = await imageRequest(context, { type: "cancel", ticket: job.ticket });
  if (result.type !== "cancelled") throw new Error("Invalid image cancellation response.");
  return result.disposition === "requested"
    ? "Cancellation requested. The provider may still finish and charge for running work."
    : result.disposition === "already_completed"
      ? "The provider already completed this request. Resume to retrieve the result without generating again."
      : "The provider request was not found; it may have expired or been cancelled.";
}
export async function finishImageJob(
  context: ToolExecutionContext,
  job: ImageGenerationJob,
): Promise<ImageGenerationJob> {
  if (job.state === "completed") return job;
  if (!job.ticket && job.state === "failed")
    throw new Error(job.error ?? "Image submission was rejected before generation.");
  if (!job.ticket)
    throw new Error(
      `Submission status unknown for ${job.generationId}. Do not generate again automatically.`,
    );
  try {
    let imageCount: number | undefined;
    for (let attempt = 0; attempt < POLL_LIMIT; attempt++) {
      context.abortSignal.throwIfAborted();
      const result = await imageRequest(context, { type: "status", ticket: job.ticket });
      if (result.type !== "status") throw new Error("Invalid image status response.");
      if (result.status === "completed") {
        imageCount = result.imageCount;
        break;
      }
      await context.imageGenerationPort!.wait(POLL_INTERVAL_MS, context.abortSignal);
    }
    if (!imageCount)
      throw new Error(
        "Image generation is still pending. Resume this generation ID to continue waiting without a new charge.",
      );
    if (imageCount !== job.input.count)
      throw new Error(
        `Provider returned ${imageCount} images; requested ${job.input.count}. No new request was submitted.`,
      );
    for (let index = job.images.length; index < imageCount; index++) {
      const chunks: Uint8Array[] = [];
      let offset = 0;
      let image;
      do {
        context.abortSignal.throwIfAborted();
        const result = await imageRequest(context, {
          type: "download",
          ticket: job.ticket,
          index,
          offset,
        });
        if (result.type !== "chunk") throw new Error("Invalid image download response.");
        const bytes = Buffer.from(result.data, "base64");
        if (
          result.totalBytes > IMAGE_MAX_BYTES ||
          offset + bytes.length > result.totalBytes ||
          !bytes.length
        )
          throw new Error("Invalid image size from provider.");
        if (result.nextOffset !== null && result.nextOffset !== offset + bytes.length)
          throw new Error("Image chunk sequence is invalid.");
        chunks.push(bytes);
        offset += bytes.length;
        image = result;
      } while (image.nextOffset !== null);
      if (offset !== image.totalBytes) throw new Error("Image download is incomplete.");
      const expectedMime = `image/${job.input.format}`;
      if (image.mime !== expectedMime)
        throw new Error(`Provider returned ${image.mime}, requested ${expectedMime}.`);
      if (
        job.input.width !== undefined &&
        (image.width !== job.input.width || image.height !== job.input.height)
      )
        throw new Error("Provider did not honor the requested exact image dimensions.");
      context.abortSignal.throwIfAborted();
      const artifact = await context.artifactStore?.writeToolResultBinaryArtifact?.(
        {
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId: `${job.generationId}-${index}`,
          toolName: "GenerateImage",
          content: Buffer.concat(chunks),
          contentType: image.mime,
          extension: job.input.format,
          retention: "session",
          trace: context.traceContext,
        },
        { signal: context.abortSignal },
      );
      if (!artifact) throw new Error("Image artifact storage unavailable.");
      job.images.push({
        ref: artifact.uri,
        fileName: `generated-${index + 1}.${job.input.format}`,
        mime: image.mime,
        bytes: artifact.bytes,
        width: image.width,
        height: image.height,
      });
      await saveImageJob(context, job);
    }
    context.abortSignal.throwIfAborted();
    job.state = "completed";
    delete job.error;
    await saveImageJob(context, job);
    return job;
  } catch (error) {
    job.error = error instanceof Error ? error.message : "Image generation failed.";
    if (context.abortSignal.aborted) {
      // 主轮停止后只取消远端/保存事实，不排入任何新轮次，避免迟到结果唤醒任务。
      await cancelImageJob(context, job).catch(() => {});
    } else {
      job.state = "failed";
      await saveImageJob(context, job);
    }
    throw new Error(
      `${job.error} Generation ID: ${job.generationId}. Use ManageImageGeneration to inspect or recover; do not submit a replacement automatically.`,
      { cause: error },
    );
  }
}
