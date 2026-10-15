// Modified by ZCode Feiyu.
import { ChatGPTSubscriptionError } from "../domain/errors.js";

/** 网络端口返回目录后按解码字节执行准入限额，不把无界 json() 结果提交给 owner。 */
export async function readSubscriptionCatalogResponse(
  response: Response,
  signal?: AbortSignal,
  maximumBytes = 16 * 1024 * 1024,
): Promise<unknown> {
  if (!response.body) throw new ChatGPTSubscriptionError("catalog_invalid");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let bytes = 0,
    text = "";
  try {
    for (;;) {
      signal?.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximumBytes) throw new ChatGPTSubscriptionError("catalog_invalid");
      text += decoder.decode(part.value, { stream: true });
    }
    signal?.throwIfAborted();
    try {
      return JSON.parse(text + decoder.decode()) as unknown;
    } catch {
      throw new ChatGPTSubscriptionError("catalog_invalid");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
