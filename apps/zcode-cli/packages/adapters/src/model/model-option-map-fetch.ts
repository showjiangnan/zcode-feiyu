import type {
  CompiledModelOptionMaps,
  JsonObject,
  ModelOptionValues,
} from "@zcode/model-option-map";

type ProviderFetch = typeof globalThis.fetch;

export interface RawRequestBodyCapture {
  body?: JsonObject;
}

export function createModelOptionMapFetch(input: {
  readonly capture?: RawRequestBodyCapture;
  readonly fetch: ProviderFetch;
  readonly maps: CompiledModelOptionMaps;
  readonly values: ModelOptionValues;
  readonly fastMode?: boolean;
}): ProviderFetch {
  return async (request, init) => {
    const bodyText = await readRequestBody(request, init);
    if (bodyText === undefined) return input.fetch(request, init);
    const body = parseJsonObject(bodyText);
    const mapped = input.maps.apply(body, input.values);
    const patched = input.fastMode ? { ...mapped, service_tier: "fast" } : mapped;
    if (input.capture) input.capture.body = patched;
    const send = (body: JsonObject) => request instanceof Request
      ? input.fetch(new Request(request, { ...init, body: JSON.stringify(body) }))
      : input.fetch(request, { ...init, body: JSON.stringify(body) });
    const response = await send(patched);
    const signal = init?.signal ?? (request instanceof Request ? request.signal : undefined);
    if (input.fastMode && !signal?.aborted && await isUnsupportedFastResponse(response)) {
      // 上游未统一保证 Fast 自动降级，只对已拒绝的参数错误重试标准模式，避免重复生成。
      await response.body?.cancel();
      const standard = { ...patched, service_tier: "default" };
      if (input.capture) input.capture.body = standard;
      return send(standard);
    }
    return response;
  };
}

async function readRequestBody(
  request: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<string | undefined> {
  if (typeof init?.body === "string") return init.body;
  // Option Map 是 reasoning/max-output 的唯一请求字段权威。若 SDK 改成非文本 Body 却静默
  // 跳过 Patch，请求仍会发出但丢失两个 Option；因此有 Body 时必须 fail-closed。
  if (init?.body !== undefined && init.body !== null) {
    throw new Error("Model option maps require a JSON text request body.");
  }
  if (request instanceof Request) return request.clone().text();
  return undefined;
}

function parseJsonObject(body: string): JsonObject {
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model option maps require a JSON object request body.");
  }
  return parsed as JsonObject;
}

async function isUnsupportedFastResponse(response: Response): Promise<boolean> {
  if (response.status !== 400 || !response.body) return false;
  const reader = response.clone().body!.getReader();
  let text = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16_000) return false;
      text += decoder.decode(part.value, {stream: true});
    }
    const parsed: unknown = JSON.parse(text + decoder.decode());
    if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return false;
    const error = parsed.error;
    if (!error || typeof error !== "object") return false;
    const param = "param" in error ? error.param : undefined;
    const code = "code" in error ? error.code : undefined;
    const message = "message" in error && typeof error.message === "string" ? error.message : "";
    return (param === "service_tier" && ["unsupported_value", "unsupported_parameter", "invalid_value", "invalid_request_error"].includes(String(code))) || (/service_tier/iu.test(message) && /fast|priority/iu.test(message) && /unsupported|not supported|not available|不支持/iu.test(message));
  } catch { return false; }
  finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
