// Modified by ZCode Feiyu.
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import type {
  ConversationRowTarget,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  v4AttachmentBeginParamsSchema,
  v4AttachmentChunkParamsSchema,
  v4AttachmentCommitParamsSchema,
  v4AttachmentAbortParamsSchema,
  v4AttachmentReadParamsSchema,
  v4ConversationAttachmentReadParamsSchema,
  ZCodeAttachmentFaultError,
  ZCODE_ATTACHMENT_FAULT_CODES,
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatParamsSchema,
  PROTOCOL_V4_LIMITS,
  v4ConversationAttachmentStatResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { toShareStatFault } from "./v4-gateway-conversation-v4-gateway-options.js";
import type { ConversationV4Gateway } from "./v4-gateway.js";

export function resolveQueryRowTarget(
  this: ConversationV4Gateway,
  publisher: ConversationTopicPublisher,
  params: {
    target: ConversationRowTarget;
    baseRevision: number;
    baseLogEpoch: string;
  },
  action: "fileChanges" | "fileRewindPreview",
): Extract<ReturnType<ConversationTopicPublisher["resolveRowActionTarget"]>, { ok: true }> {
  const snapshot = publisher.getSnapshot();
  if (params.baseLogEpoch !== snapshot.logEpoch) throw new Error("proto.staleLogEpoch");
  if (params.baseRevision !== snapshot.revision) throw new Error("proto.staleRevision");
  const resolution = publisher.resolveRowActionTarget(params.target, action);
  if (!resolution.ok) throw new Error(resolution.reasonCode);
  return resolution;
}

export async function attachmentBegin(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4AttachmentBeginResult> {
  const params = v4AttachmentBeginParamsSchema.parse(rawParams);
  if (!this["host"].putSessionAttachment) {
    throw new Error("fault.attachment.putUnsupported");
  }
  if (!this["host"].sessionExists(params.sessionId)) {
    await this["coldResume"].ensureResumed(params.sessionId);
  }
  return this["attachmentUploads"].begin(params);
}

export async function attachmentChunk(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4AttachmentChunkResult> {
  return this["attachmentUploads"].chunk(v4AttachmentChunkParamsSchema.parse(rawParams));
}

export function attachmentCommit(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4AttachmentCommitResult> {
  return this["attachmentUploads"].commit(v4AttachmentCommitParamsSchema.parse(rawParams));
}

export async function attachmentAbort(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<void> {
  await this["attachmentUploads"].abort(v4AttachmentAbortParamsSchema.parse(rawParams));
}

export async function attachmentRead(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4AttachmentReadResult> {
  const params = v4AttachmentReadParamsSchema.parse(rawParams);
  if (!this["host"].readSessionAttachment) {
    throw new Error("fault.attachment.readUnsupported");
  }
  const existingReady = this["readyFlights"].get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !this["host"].sessionExists(params.sessionId)
      ? await this["ensureColdReadyPublisher"](params.sessionId)
      : await this["hydratePublisher"](params.sessionId);
  const resolution = this["resolveReadableMediaAttachment"](
    publisher,
    params.sessionId,
    params.ref,
    params.target,
    params.attachmentIndex,
  );
  if (!resolution) {
    // renderer 传来的 ref 不能直接成为文件路径；必须先由当前 session
    // 的权威 user row 证明归属，避免跨 session 或任意路径读取。
    throw new Error("fault.attachment.previewRefNotAuthorized");
  }
  const payload = await this["readAttachmentPayload"](
    params.sessionId,
    params.ref,
    resolution.attachment.mime,
    resolution.messageId,
    resolution.attachmentIndex,
  );
  if (params.offset > payload.bytes.byteLength) {
    throw new Error("fault.attachment.previewRangeInvalid");
  }
  const end = Math.min(payload.bytes.byteLength, params.offset + params.limit);
  const chunk = payload.bytes.subarray(params.offset, end);
  return {
    dataBase64: Buffer.from(chunk).toString("base64"),
    mediaType: payload.mediaType,
    totalBytes: payload.bytes.byteLength,
    nextOffset: end < payload.bytes.byteLength ? end : null,
  };
}

export async function conversationAttachmentRead(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4ConversationAttachmentReadResult> {
  const params = v4ConversationAttachmentReadParamsSchema.parse(rawParams);
  if (!this["host"].readSessionAttachment) {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.readUnsupported);
  }
  const existingReady = this["readyFlights"].get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !this["host"].sessionExists(params.sessionId)
      ? await this["ensureColdReadyPublisher"](params.sessionId)
      : await this["hydratePublisher"](params.sessionId);
  const row = publisher
    .getSnapshot()
    .rows.window.find(
      (candidate) =>
        candidate.rowId === params.target.rowId && candidate.entityId === params.target.entityId,
    );
  if (row?.kind !== "userInput") {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized);
  }
  const attachment = row.attachments?.[params.attachmentIndex];
  if (!attachment || (attachment.ref !== params.ref && attachment.previewRef !== params.ref)) {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized);
  }
  const messageId = publisher.getMessageIdForRow(row.rowId) ?? undefined;
  let payload: {
    bytes: Uint8Array;
    mediaType: string;
  };
  try {
    payload = await this["readAttachmentPayload"](
      params.sessionId,
      params.ref,
      attachment.mime,
      messageId,
      params.attachmentIndex,
      true,
    );
  } catch (error) {
    throw toShareStatFault(error);
  }
  if (params.offset > payload.bytes.byteLength) {
    throw new Error("fault.attachment.previewRangeInvalid");
  }
  const end = Math.min(payload.bytes.byteLength, params.offset + params.limit);
  const chunk = payload.bytes.subarray(params.offset, end);
  return v4ConversationAttachmentReadResultSchema.parse({
    dataBase64: Buffer.from(chunk).toString("base64"),
    mediaType: payload.mediaType,
    totalBytes: payload.bytes.byteLength,
    nextOffset: end < payload.bytes.byteLength ? end : null,
  });
}

export async function conversationAttachmentStat(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4ConversationAttachmentStatResult> {
  const params = v4ConversationAttachmentStatParamsSchema.parse(rawParams);
  if (!this["host"].statSessionAttachment) {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statUnsupported);
  }
  const existingReady = this["readyFlights"].get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !this["host"].sessionExists(params.sessionId)
      ? await this["ensureColdReadyPublisher"](params.sessionId)
      : await this["hydratePublisher"](params.sessionId);
  const row = publisher
    .getSnapshot()
    .rows.window.find(
      (candidate) =>
        candidate.rowId === params.target.rowId && candidate.entityId === params.target.entityId,
    );
  if (row?.kind !== "userInput") {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized);
  }
  const attachment = row.attachments?.[params.attachmentIndex];
  if (!attachment || (attachment.ref !== params.ref && attachment.previewRef !== params.ref)) {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized);
  }
  const messageId = publisher.getMessageIdForRow(row.rowId) ?? undefined;
  let result: {
    totalBytes: number;
    mediaType: string;
    mtimeMs?: number;
  };
  try {
    result = await this["host"].statSessionAttachment(params.sessionId, {
      ref: params.ref,
      mime: attachment.mime,
      ...(messageId ? { messageId } : {}),
      attachmentIndex: params.attachmentIndex,
    });
  } catch (error) {
    // 「附件确实不在了」是 share 预检唯一能确定判定为跳过的分类，必须以稳定码上抛；
    // 否则 service 只能猜错误文本。
    throw toShareStatFault(error);
  }
  // stat 结果曾被 30MiB 的 schema 上限卡住，超大附件在这里抛 ZodError，
  // 于是 share 预检把「已知容量超限」这个确定阻断降级成 deferred 并静默丢内容。
  // 上限放宽后仍需要一个显式出口：真的超过协议可表达范围时给出稳定码。
  if (result.totalBytes > PROTOCOL_V4_LIMITS.attachmentStatMaxBytes) {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatTooLarge);
  }
  return v4ConversationAttachmentStatResultSchema.parse(result);
}
