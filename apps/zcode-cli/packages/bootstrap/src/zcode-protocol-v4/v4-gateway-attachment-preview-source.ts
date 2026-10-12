// Modified by ZCode Feiyu.
import type {
  V4AttachmentPreviewSourceResult,
  AttachmentRef,
} from "@zcode/shared/zcode-protocol-v4";
import {
  v4AttachmentPreviewSourceParamsSchema,
  v4AttachmentPreviewSourceResultSchema,
  PROTOCOL_V4_LIMITS,
  ZCodeAttachmentFaultError,
  ZCODE_ATTACHMENT_FAULT_CODES,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import { artifactRefBelongsToSession } from "./v4-gateway-conversation-v4-gateway-options.js";
import { extractMarkdownArtifactImageRefs } from "@zcode/shared";
import type { ConversationV4Gateway } from "./v4-gateway.js";

export async function attachmentPreviewSource(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4AttachmentPreviewSourceResult> {
  const params = v4AttachmentPreviewSourceParamsSchema.parse(rawParams);
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
    throw new Error("fault.attachment.previewRefNotAuthorized");
  }
  if (
    params.clientMode !== "desktop-continuous" ||
    !resolution.attachment.mime.startsWith("video/") ||
    !this["host"].resolveSessionAttachmentPreviewSource
  ) {
    return { kind: "chunked" };
  }
  const result = await this["host"].resolveSessionAttachmentPreviewSource(params.sessionId, {
    ref: params.ref,
    mime: resolution.attachment.mime,
    ...(resolution.messageId ? { messageId: resolution.messageId } : {}),
    ...(resolution.attachmentIndex !== undefined
      ? { attachmentIndex: resolution.attachmentIndex }
      : {}),
  });
  return v4AttachmentPreviewSourceResultSchema.parse(result);
}

export function resolveReadableMediaAttachment(
  this: ConversationV4Gateway,
  publisher: ConversationTopicPublisher,
  sessionId: string,
  ref: string,
  target?: {
    rowId: number;
    entityId: string;
  },
  attachmentIndex?: number,
): { attachment: AttachmentRef; messageId?: string; attachmentIndex?: number } | null {
  const isPreviewable = (attachment: AttachmentRef) => {
    const mime = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    // 根因：原预览仅放行图片、视频和 PDF，文本附件即使归属当前行也被拒绝。
    // 文本只开放既有材料标记，后续仍须通过权威行、附件索引和 ref 的归属校验。
    return (
      mime.startsWith("image/") ||
      mime.startsWith("video/") ||
      mime === "application/pdf" ||
      (mime === "text/plain" &&
        (attachment.sourceKind === "topic-history" || attachment.sourceKind === "clipboard-text"))
    );
  };
  const matchesRef = (attachment: AttachmentRef) =>
    attachment.ref === ref || attachment.previewRef === ref;
  if (target && attachmentIndex !== undefined) {
    const row = publisher
      .getSnapshot()
      .rows.window.find(
        (candidate) => candidate.rowId === target.rowId && candidate.entityId === target.entityId,
      );
    if (row?.kind !== "userInput") return null;
    const attachment = row.attachments?.[attachmentIndex];
    if (!attachment || !isPreviewable(attachment) || !matchesRef(attachment)) {
      return null;
    }
    // 热态 renderer 可能还持有 original ref，而 hydrate 后的权威 row 已补
    // previewRef；两者属于同一个 row/index，授权不能因投影时序不同而误判为跨行读取。
    const messageId = publisher.getMessageIdForRow(row.rowId);
    return {
      attachment,
      attachmentIndex,
      ...(messageId ? { messageId } : {}),
    };
  }
  // 旧 renderer 没有 row target，无法按消息定位持久 artifact；一旦
  // previewRef 存在就只能授权该 durable ref，不能重新放行可变的原始路径。
  for (const row of publisher.getSnapshot().rows.window) {
    if (row.kind === "toolCall" && artifactRefBelongsToSession(ref, sessionId)) {
      const display = row.output?.display;
      if (display?.kind === "image_generation") {
        const attachment = display.images.find((image) => image.ref === ref);
        if (attachment) return { attachment };
      }
    }
    if (row.kind === "userInput") {
      for (const attachment of row.attachments ?? []) {
        if (!isPreviewable(attachment)) continue;
        if ((attachment.previewRef ?? attachment.ref) === ref) return { attachment };
      }
    }
    if (
      row.kind === "assistantText" &&
      artifactRefBelongsToSession(ref, sessionId) &&
      extractMarkdownArtifactImageRefs(row.text).includes(ref)
    ) {
      // assistant Markdown 可以引用工具产出的 session artifact，
      // 但旧授权只查看 userInput.attachments，导致合法图片到 UI 后被 harden
      // 拦截。仍以当前 session 的权威投影做精确 ref 授权，绝不接受 renderer
      // 自报的任意 artifact/path。Markdown 是模型可控文本，所以 URI authority
      // 还必须与当前请求 session 精确匹配；仅“当前投影里出现过”不能证明它有权
      // 读取另一个 session 的 artifact。
      return {
        attachment: {
          ref,
          fileName: "assistant-image",
          mime: "image/*",
          bytes: 0,
        },
      };
    }
  }
  return null;
}

export function readAttachmentPayload(
  this: ConversationV4Gateway,
  sessionId: string,
  ref: string,
  mime: string,
  messageId?: string,
  attachmentIndex?: number,
  allowGeneric = false,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const now = this["now"]();
  this["pruneBinaryReadCache"](now);
  // 首段标签 `att`：这张表与 dwf 产物字节共用（见 BinaryReadCacheEntry），两个键空间
  // 只能靠一个不可能相等的首段隔离。
  const key = `att\u0000${sessionId}\u0000${messageId ?? "legacy"}\u0000${attachmentIndex ?? -1}\u0000${ref}`;
  const cached = this["binaryReadCache"].get(key);
  if (cached) {
    cached.accessedAt = now;
    return cached.payload;
  }
  // 预览读取曾复用上传的 20MiB 总量上限；video 使用已有全局输入上限，
  // image 和上传事务继续保持原边界。
  const maxBytes = allowGeneric
    ? PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes
    : mime.startsWith("video/")
      ? PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes
      : PROTOCOL_V4_LIMITS.attachmentMaxBytes;
  const payload = this["host"].readSessionAttachment!(sessionId, {
    ref,
    mime,
    maxBytes,
    ...(messageId ? { messageId } : {}),
    ...(attachmentIndex !== undefined ? { attachmentIndex } : {}),
  })
    .then((result) => {
      const resultMime = result.mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (
        !allowGeneric &&
        !resultMime.startsWith("image/") &&
        !resultMime.startsWith("video/") &&
        resultMime !== "application/pdf" &&
        !(
          resultMime === "text/plain" &&
          mime.split(";", 1)[0]?.trim().toLowerCase() === "text/plain"
        )
      ) {
        throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.previewNotMedia);
      }
      if (result.bytes.byteLength > maxBytes) {
        throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.previewTooLarge);
      }
      const current = this["binaryReadCache"].get(key);
      if (current) {
        current.bytes = result.bytes.byteLength;
        this["binaryReadCacheBytes"] += result.bytes.byteLength;
        this["pruneBinaryReadCache"](this["now"]());
      }
      return result;
    })
    .catch((error) => {
      this["deleteBinaryReadCacheEntry"](key);
      throw error;
    });
  this["binaryReadCache"].set(key, { sessionId, accessedAt: now, bytes: null, payload });
  return payload;
}
