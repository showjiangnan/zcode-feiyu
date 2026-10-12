// Modified by ZCode Feiyu.
import { createNetworkProxyFetch } from "../network/proxy-fetch.js";
import { normalizeModelTlsFailure } from "./failure-tls.js";
import {
  ProviderBusinessErrorFetchOptions,
  ProviderFetch,
  ProviderProxyFetchOptions,
} from "./model-execution-types.js";
import {
  ProviderBusinessError,
  readProviderBusinessFailureFromBody,
} from "./provider-business-error.js";
import { createProviderBusinessErrorSseResponse } from "./provider-business-stream.js";
import { createProviderEndpointRoutingFetch } from "./provider-endpoint-routing-fetch.js";

export const MAX_BUSINESS_ERROR_BODY_CHARS = 64_000;

export const PROVIDER_BUSINESS_ERROR_BODY_CLEANUP_TIMEOUT_MS = 1_000;

export function createProviderBusinessErrorFetch(
  options: ProviderBusinessErrorFetchOptions,
): ProviderFetch {
  const networkFetch = createProviderProxyFetch(options);
  const baseFetch = options.endpointRoutingPort
    ? createProviderEndpointRoutingFetch({
        fetch: networkFetch,
        routingPort: options.endpointRoutingPort,
      })
    : networkFetch;

  return async (input, init) => {
    let response: Response;
    try {
      response = await baseFetch(input, init);
    } catch (error) {
      throw normalizeModelTlsFailure(error);
    }

    // zcode-plan 安全校验拒绝（3007）等场景返回 HTTP 403 + JSON，但未必带
    // Content-Type: application/json。若只在启发式命中时才读 body，fetch 会把 403 原样交给
    // AI SDK，流式请求可能以空 completion 结束，core 最终误报 suspicious empty。
    if (!response.ok) {
      const nonOkBusinessError = await detectProviderBusinessError(response, options);
      if (nonOkBusinessError) {
        await consumeBusinessErrorResponseBodyBestEffort(response);
        throw nonOkBusinessError;
      }
    }

    if (responseMayContainSseBusinessError(response)) {
      return createProviderBusinessErrorSseResponse(response, options);
    }

    const businessError = await detectProviderBusinessError(response, options);
    if (businessError) {
      await consumeBusinessErrorResponseBodyBestEffort(response);
      throw businessError;
    }
    return response;
  };
}

export async function consumeBusinessErrorResponseBodyBestEffort(
  response: Response,
): Promise<void> {
  const body = response.body;
  if (!body) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // 业务错误检测消费的是 response.clone()；只 cancel 原始 tee 分支时，
    // Undici 的 cancel Promise 完成也不保证连接已可复用，连续 429 仍会耗尽连接槽。
    // 已识别的业务错误体受 64KB 上限保护，完整消费原始分支后连接才能稳定复用；
    // 异常 stream 永不收敛时则由清理上限兜底，不能阻塞已经解析出的原始错误。
    await Promise.race([
      response.arrayBuffer().then(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, PROVIDER_BUSINESS_ERROR_BODY_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // 清理失败不能覆盖已经解析出的 provider 原始错误。
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function createProviderProxyFetch(options: ProviderProxyFetchOptions): ProviderFetch {
  // Node 的 global fetch 不会自动读取 HTTP_PROXY/http_proxy。
  // 模型 provider 和 MCP HTTP transport 都复用同一层 proxy-aware fetch，避免多套出口规则漂移。
  return createNetworkProxyFetch(options);
}

export async function detectProviderBusinessError(
  response: Response,
  options: ProviderBusinessErrorFetchOptions,
): Promise<ProviderBusinessError | undefined> {
  if (!responseMayContainBusinessJson(response)) {
    return undefined;
  }

  let body: unknown;
  try {
    const text = await readLimitedResponseText(response);
    if (text === undefined || text.trim().length === 0) {
      return undefined;
    }
    body = JSON.parse(text);
  } catch {
    return undefined;
  }

  const failure = readProviderBusinessFailureFromBody(body);
  if (!failure) {
    return undefined;
  }

  return new ProviderBusinessError({
    providerCode: failure.providerCode,
    providerId: options.providerId,
    providerKind: options.providerKind,
    providerMessage: failure.providerMessage,
    providerRequestId: failure.providerRequestId,
    responseBodySummary: failure.responseBodySummary,
    // fetch 层的 ProviderBusinessError 会绕过 APICallError；
    // 不保留响应头会导致 retry-after/retry-after-ms 在重试计算前丢失。
    responseHeaders: responseHeadersToRecord(response.headers),
    responseStatus: response.status,
    statusCode: failure.statusCode,
  });
}

export function responseMayContainBusinessJson(response: Response): boolean {
  // 非 2xx 一律尝试读 body 解析业务码（403/3007、429/3002 等），不依赖 Content-Type 猜测。
  if (!response.ok) {
    return true;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("event-stream")) {
    return false;
  }
  if (contentType.includes("json")) {
    return true;
  }

  const contentLength = parseContentLength(response.headers.get("content-length"));
  return contentLength !== undefined && contentLength <= MAX_BUSINESS_ERROR_BODY_CHARS;
}

export async function readLimitedResponseText(response: Response): Promise<string | undefined> {
  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > MAX_BUSINESS_ERROR_BODY_CHARS) {
    return undefined;
  }

  const clone = response.clone();
  if (!clone.body) {
    const text = await clone.text();
    return text.length > MAX_BUSINESS_ERROR_BODY_CHARS ? undefined : text;
  }

  const reader = clone.body.getReader();
  const decoder = new TextDecoder();
  let text = "";

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        text += decoder.decode();
        return text.length > MAX_BUSINESS_ERROR_BODY_CHARS ? undefined : text;
      }

      text += decoder.decode(chunk.value, { stream: true });
      if (text.length > MAX_BUSINESS_ERROR_BODY_CHARS) {
        await reader.cancel();
        return undefined;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function responseMayContainSseBusinessError(response: Response): boolean {
  return (
    response.body !== null &&
    response.headers.get("content-type")?.toLowerCase().includes("event-stream") === true
  );
}

import { responseHeadersToRecord } from "./provider-business-error.js";
