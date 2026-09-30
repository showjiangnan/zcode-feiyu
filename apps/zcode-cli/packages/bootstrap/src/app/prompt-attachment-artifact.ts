// Modified by ZCode Feiyu contributors (2026).
import type { ToolArtifactStorePort, TraceContext } from "@zcode/contracts";

function decodeDataUrl(content: string, fallbackMime: string, maxBytes: number) {
  const commaIndex = content.indexOf(",");
  const headerParts =
    content.slice(0, "data:".length).toLowerCase() === "data:" && commaIndex >= 0
      ? content.slice("data:".length, commaIndex).split(";")
      : [];
  const mediaType = (headerParts.shift()?.trim() || fallbackMime).split(";", 1)[0]!.toLowerCase();
  const payload = commaIndex >= 0 ? content.slice(commaIndex + 1) : "";
  if (
    headerParts.at(-1)?.trim().toLowerCase() !== "base64" ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload) ||
    payload.length % 4 !== 0
  )
    throw new Error("fault.attachment.previewArtifactInvalid");
  if (!isMedia(mediaType)) throw new Error("fault.attachment.previewNotMedia");
  const bytes = Buffer.from(payload, "base64");
  if (bytes.byteLength > maxBytes) throw new Error("fault.attachment.previewTooLarge");
  return { bytes, mediaType };
}
const isMedia = (mime: string) =>
  mime.startsWith("image/") || mime.startsWith("video/") || mime === "application/pdf";

/** 调用方已经通过 V4 精确引用授权；这里只负责两种现存 artifact 编码的读回。 */
export async function readPromptAttachmentArtifact(
  store: ToolArtifactStorePort,
  input: {
    ref: string;
    mediaType: string;
    maxBytes: number;
    trace: TraceContext;
  },
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const request = { uri: input.ref, trace: input.trace };
  const stat = await store.statToolResultArtifact?.(request);
  if (stat && isMedia(stat.contentType)) {
    // 图片工具保存原图二进制，旧入口只接受 Data URL 文本，导致成功生成后预览仍失败。
    if (!store.readToolResultBinaryArtifact)
      throw new Error("fault.attachment.previewReadUnsupported");
    if (stat.bytes > input.maxBytes) throw new Error("fault.attachment.previewTooLarge");
    const result = await store.readToolResultBinaryArtifact(request);
    if (result.bytes.byteLength > input.maxBytes)
      throw new Error("fault.attachment.previewTooLarge");
    return { bytes: result.bytes, mediaType: stat.contentType };
  }
  const artifact = await store.readToolResultArtifact(request);
  return decodeDataUrl(artifact.content, input.mediaType, input.maxBytes);
}
