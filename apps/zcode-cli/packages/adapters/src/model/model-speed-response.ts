// Modified by ZCode Feiyu.
import { modelServiceTierSchema, type ModelSpeedObservation } from "@zcode/shared";

const MAX_OBSERVATION_FRAME_LENGTH = 16 * 1024 * 1024;

export function observeModelSpeedResponse(
  response: Response,
  observation: ModelSpeedObservation,
): Response {
  if (!response.ok || !response.body) return response;
  const sse = response.headers.get("content-type")?.includes("text/event-stream");
  let buffer = "";
  const decoder = new TextDecoder();
  const read = (text: string) => {
    try {
      const event: unknown = JSON.parse(text);
      if (!event || typeof event !== "object") return;
      const envelope = event as Record<string, unknown>;
      const payload = sse ? envelope.response : envelope;
      if (!payload || typeof payload !== "object") return;
      const result = payload as Record<string, unknown>;
      // created 可能还是预分配档位；只有成功终态可作为实际速度验收事实。
      if (result.status !== "completed" || (sse && envelope.type !== "response.completed")) return;
      const tier = modelServiceTierSchema.safeParse(result.service_tier);
      if (tier.success) observation.actualServiceTier = tier.data;
    } catch {
      /* 分帧完整后才解析；未知响应不编造实际速度。 */
    }
  };
  const readFrame = (frame: string) => {
    const data = frame
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data && data !== "[DONE]") read(data);
  };
  const consumeFrames = () => {
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/u.exec(buffer))) {
      readFrame(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
    }
  };
  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        if (sse) consumeFrames();
        if (buffer.length > MAX_OBSERVATION_FRAME_LENGTH) buffer = "";
        controller.enqueue(chunk);
      },
      flush() {
        buffer += decoder.decode();
        // 兼容未以空行结束的最后一个 SSE 帧；正文仍原样透传给原 SDK/终态校验。
        if (sse) {
          consumeFrames();
          if (buffer) readFrame(buffer);
        } else read(buffer);
      },
    }),
  );
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
