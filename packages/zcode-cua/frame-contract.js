// Modified by ZCode Feiyu contributors (2026).
export const OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY = "zcode.cua/official-frame-integrity-v1";
export const OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION = "official_cua_frame_v1";
export const OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES = 16 * 1024 * 1024;
const prefix = "zcode-cua-image-ref:";
export function parseOfficialCuaImageRef(text) {
  if (typeof text !== "string" || !text.startsWith(prefix) || text.length > 8192) return;
  try {
    const value = JSON.parse(text.slice(prefix.length));
    if (
      typeof value.authority === "string" &&
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value.authority)
    )
      return value;
  } catch {
    /* Invalid external text is not a frame reference. */
  }
}
export function isOfficialCuaImageRefText(text) {
  return Boolean(parseOfficialCuaImageRef(text));
}
export function containsOfficialCuaImageRefCredentialText(text) {
  return typeof text === "string" && text.includes(prefix);
}
export const containsImageRefAuthority = containsOfficialCuaImageRefCredentialText;
export function readRasterEnvelopeIdentity(input) {
  const ref = typeof input === "string" ? parseOfficialCuaImageRef(input) : input;
  if (!ref?.authority) return;
  try {
    const encoded = ref.authority.split(".")[0];
    const claims = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
          c.charCodeAt(0),
        ),
      ),
    );
    if (
      claims.algorithm !== "sha256" ||
      !/^[a-f0-9]{64}$/.test(claims.sha256) ||
      typeof claims.targetId !== "string" ||
      typeof claims.imageId !== "string" ||
      !Number.isSafeInteger(claims.width) ||
      !Number.isSafeInteger(claims.height) ||
      claims.width < 1 ||
      claims.height < 1
    )
      return;
    return claims;
  } catch {
    return;
  }
}
export function findOfficialCuaFrameContentPair(content) {
  if (!Array.isArray(content)) return;
  for (let i = content.length - 2; i >= 0; i--)
    if (
      content[i]?.type === "image" &&
      content[i + 1]?.type === "text" &&
      isOfficialCuaImageRefText(content[i + 1].text)
    )
      return { image: content[i], imageRef: content[i + 1], imageIndex: i, imageRefIndex: i + 1 };
}
function frameImageData(image) {
  // 两种载荷不可混用；远端 URL 不能提供原始栅格证据。
  if (
    typeof image.data === "string" &&
    image.dataUrl === undefined &&
    image.mimeType === "image/png"
  )
    return image.data;
  const prefix = "data:image/png;base64,";
  if (
    image.data === undefined &&
    image.mediaType === "image/png" &&
    typeof image.dataUrl === "string" &&
    image.dataUrl.startsWith(prefix)
  )
    return image.dataUrl.slice(prefix.length);
}
export function attestOfficialCuaFrameContent(
  // MCP 原图与 CLI 模型图片的字段不同，最终校验接受两种明确格式。
  content,
  expectedKind = OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
) {
  if (expectedKind !== OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION || !Array.isArray(content))
    return;
  const targets = new Set();
  let count = 0;
  for (let i = 0; i < content.length - 1; i++) {
    if (
      content[i]?.type !== "image" ||
      content[i + 1]?.type !== "text" ||
      !isOfficialCuaImageRefText(content[i + 1].text)
    )
      continue;
    const claims = readRasterEnvelopeIdentity(content[i + 1].text);
    const data = frameImageData(content[i]);
    if (
      !claims ||
      targets.has(claims.targetId) ||
      !data ||
      data.length > OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES
    )
      return;
    targets.add(claims.targetId);
    count++;
  }
  return count ? { kind: expectedKind, frameCount: count } : undefined;
}
export async function preserveOfficialCuaFrameResult(result, options = {}) {
  if (!Array.isArray(result.content)) return result;
  const { createHash } = await import("node:crypto");
  const content = [];
  let invalid = false;
  for (let i = 0; i < result.content.length; i++) {
    const block = result.content[i];
    const next = result.content[i + 1];
    if (block?.type === "image" && next?.type === "text" && isOfficialCuaImageRefText(next.text)) {
      options.signal?.throwIfAborted();
      const claims = readRasterEnvelopeIdentity(next.text);
      const data = frameImageData(block);
      const pixels =
        data && data.length <= OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES
          ? Buffer.from(data, "base64")
          : undefined;
      // 图像引用的摘要必须匹配原始字节；有引用的原图不得压缩或换图。
      if (
        !claims ||
        !pixels ||
        createHash("sha256").update(pixels).digest("hex") !== claims.sha256 ||
        pixels.length < 24 ||
        !pixels.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        pixels.readUInt32BE(16) !== claims.width ||
        pixels.readUInt32BE(20) !== claims.height
      ) {
        invalid = true;
        i++;
        continue;
      }
      content.push(block, next);
      i++;
      continue;
    }
    if (block?.type === "text" && containsOfficialCuaImageRefCredentialText(block.text)) {
      invalid = true;
      continue;
    }
    content.push(block);
  }
  if (invalid)
    content.push({
      type: "text",
      text: "A computer control frame was rejected because its provenance or pixels did not match. Read a fresh observation.",
    });
  return { ...result, content, ...(invalid ? { isError: true } : {}) };
}
