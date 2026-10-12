// Modified by ZCode Feiyu.
import { ChatGPTSubscriptionError, parseSubscriptionError } from "../domain/errors.js";

/** 一帧一次拉取，末尾失败不丢弃此前已交付的文本；只有 completed 是成功终态。 */
export function validateSubscriptionStream(response: Response, signal?: AbortSignal): Response {
  if (!response.body) throw new ChatGPTSubscriptionError("invalid_stream", response.status);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType && contentType !== "text/event-stream")
    throw new ChatGPTSubscriptionError("invalid_stream", response.status);
  const reader = response.body.getReader(),
    decoder = new TextDecoder(),
    encoder = new TextEncoder();
  let buffer = "",
    completed = false,
    ended = false;
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          for (;;) {
            signal?.throwIfAborted();
            const boundary = /\r?\n\r?\n/u.exec(buffer);
            if (boundary) {
              const frame = buffer.slice(0, boundary.index);
              buffer = buffer.slice(boundary.index + boundary[0].length);
              const data = frame
                .split(/\r?\n/u)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (data && data !== "[DONE]") {
                let event: Record<string, unknown>;
                try {
                  event = JSON.parse(data);
                } catch {
                  throw new ChatGPTSubscriptionError("invalid_stream");
                }
                const item = event.item as { type?: unknown; namespace?: unknown } | undefined;
                if (
                  item &&
                  ["function_call", "custom_tool_call"].includes(String(item.type)) &&
                  item.namespace != null &&
                  item.namespace !== "zcode"
                )
                  throw new ChatGPTSubscriptionError("tool_namespace_invalid");
                if (completed) throw new ChatGPTSubscriptionError("stream_after_terminal");
                if (event.type === "response.failed" || event.type === "error")
                  throw parseSubscriptionError(
                    event.type === "response.failed" ? event.response : event,
                    response.status,
                    requestId,
                  );
                if (event.type === "response.incomplete")
                  throw new ChatGPTSubscriptionError(
                    "response_incomplete",
                    response.status,
                    requestId,
                  );
                if (event.type === "response.completed") {
                  if ((event.response as { status?: unknown } | undefined)?.status !== "completed")
                    throw new ChatGPTSubscriptionError(
                      "invalid_terminal_status",
                      response.status,
                      requestId,
                    );
                  completed = true;
                }
              }
              controller.enqueue(encoder.encode(`${frame}\n\n`));
              return;
            }
            if (ended) {
              if (!completed || buffer.trim())
                throw new ChatGPTSubscriptionError(
                  "stream_interrupted",
                  response.status,
                  requestId,
                );
              controller.close();
              reader.releaseLock();
              return;
            }
            const part = await reader.read();
            ended = part.done === true;
            buffer += ended ? decoder.decode() : decoder.decode(part.value, { stream: true });
            if (buffer.length > 16 * 1024 * 1024)
              throw new ChatGPTSubscriptionError("stream_event_too_large");
          }
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(stream, { status: response.status, headers });
}
