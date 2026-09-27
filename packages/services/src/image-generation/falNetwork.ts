import { IMAGE_MAX_BYTES } from "@zcode/shared";

export function imageApiUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Image API URL must be HTTPS without credentials, query or fragment.");
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}
export function validateQueueUrl(value: string, apiUrl: string): string {
  const base = imageApiUrl(apiUrl),
    url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    (base.pathname !== "/" && !url.pathname.startsWith(`${base.pathname}/`))
  )
    throw new Error("Image provider returned an untrusted queue URL.");
  return url.href;
}
export function validateMediaUrl(value: string, apiUrl: string): string {
  const url = new URL(value),
    base = imageApiUrl(apiUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !(
      url.origin === base.origin ||
      url.hostname.endsWith(".fal.media") ||
      url.hostname === "fal.media"
    )
  )
    throw new Error("Image provider returned an unsupported media host.");
  return url.href;
}
export async function readBounded(
  response: Response,
  maxBytes = IMAGE_MAX_BYTES,
): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));
  if (length > maxBytes) {
    await response.body?.cancel();
    throw new Error("Image response exceeds the size limit.");
  }
  if (!response.body) throw new Error("Image provider returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      if (total > maxBytes) throw new Error("Image response exceeds the size limit.");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}
export function detectImageMime(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" {
  if (
    bytes[0] === 137 &&
    Buffer.from(bytes.subarray(1, 8)).equals(Buffer.from([80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (
    Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP"
  )
    return "image/webp";
  throw new Error("Image provider returned invalid image bytes.");
}
