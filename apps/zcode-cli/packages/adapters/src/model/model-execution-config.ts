// Modified by ZCode Feiyu.
import { type ModelRequestAuth } from "@zcode/contracts";
import { isApiKeyAccess, type RegistryProviderConfig } from "@zcode/provider";
import { withoutRequestVerificationHeaders } from "@zcode/shared";
import { AiSdkProviderConfig } from "./model-execution-types.js";
import { mergeModelRequestHeaders, withoutModelAuthHeaders } from "./model-request-headers.js";

export const AUTHORIZATION_HEADER_NAME = "Authorization";

export function toAiSdkProviderConfig(
  providerId: string,
  config: RegistryProviderConfig,
): AiSdkProviderConfig {
  const common = {
    ...(isApiKeyAccess(config.access) && config.access.apiKey
      ? { apiKey: config.access.apiKey }
      : {}),
    baseURL: config.api.baseUrl,
    ...(config.api.headers ? { headers: { ...config.api.headers } } : {}),
    providerOptions: {
      apiFormat: config.api.type,
      ...(config.access.type === "chatgpt-subscription"
        ? {
            zcodeSubscription: true,
            openai: { store: false, include: ["reasoning.encrypted_content"] },
          }
        : {}),
    },
    access: config.access,
  };
  switch (config.api.type) {
    case "anthropic-messages":
      return { kind: "anthropic", ...common };
    case "openai-responses":
      return { kind: "openai", ...common };
    case "openai-chat-completions":
      return { kind: "openai-compatible", name: providerId, ...common };
  }
  throw new Error(`Unsupported Provider API type: ${String(config.api.type)}`);
}

export function applyModelRequestAuth(
  providerConfig: AiSdkProviderConfig,
  requestAuth: ModelRequestAuth | undefined,
): AiSdkProviderConfig {
  if (providerConfig.access.type === "chatgpt-subscription") {
    if (providerConfig.baseURL !== "https://api.openai.com/v1" || providerConfig.kind !== "openai")
      throw new Error("subscription_endpoint_invalid");
    return { ...providerConfig, apiKey: "zcode-managed-subscription", headers: undefined };
  }
  if (!requestAuth) return providerConfig;
  const staticHeaders = withoutRequestVerificationHeaders(providerConfig.headers);
  // 账号动态身份头必须先清理静态认证头，避免 SDK 优先使用旧凭据。
  const headers =
    providerConfig.access.type === "zhipu-account"
      ? withoutModelAuthHeaders(staticHeaders)
      : staticHeaders;
  return {
    ...providerConfig,
    ...(requestAuth.apiKey ? { apiKey: requestAuth.apiKey } : {}),
    headers: mergeModelRequestHeaders(headers, requestAuth.headers),
  };
}

export function withAnthropicAuthorizationHeader(
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!apiKey || hasHeader(headers, AUTHORIZATION_HEADER_NAME)) {
    return headers;
  }

  // Anthropic 兼容网关会同时读取 x-api-key 和 Bearer Authorization；显式配置的 Authorization 保持优先。
  return {
    [AUTHORIZATION_HEADER_NAME]: `Bearer ${apiKey}`,
    ...headers,
  };
}

export function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) {
    return false;
  }
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalizedName);
}

export function normalizeAnthropicBaseURL(baseURL: string | undefined): string | undefined {
  const trimmed = baseURL?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/\/+$/u, "");
    if (pathname.toLowerCase().endsWith("/v1")) {
      url.pathname = pathname;
      return url.href;
    }

    // Anthropic's AI SDK provider appends /messages to baseURL, so explicit
    // gateway roots must include the /v1 API prefix at the adapter boundary.
    url.pathname = `${pathname}/v1`;
    return url.href;
  } catch {
    const withoutTrailingSlash = trimmed.replace(/\/+$/u, "");
    return withoutTrailingSlash.toLowerCase().endsWith("/v1")
      ? withoutTrailingSlash
      : `${withoutTrailingSlash}/v1`;
  }
}
