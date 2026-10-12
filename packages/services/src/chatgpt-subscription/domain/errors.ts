// Modified by ZCode Feiyu.
const terminalRefreshCodes = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);
const temporaryCodes = new Set([
  "network_error",
  "identity_verification_unavailable",
  "subscription_sharing_usage_unavailable",
  "subscription_sharing_user_unavailable",
  "service_unavailable",
  "discovery_unavailable",
]);

export class ChatGPTSubscriptionError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    // 原始网络/SDK错误可能包含用户上下文与凭据；公开异常只保留安全机器码。
    super(`ChatGPT subscription: ${code}${status ? ` (${status})` : ""}`);
    this.name = "ChatGPTSubscriptionError";
  }
  get terminalRefresh(): boolean {
    return terminalRefreshCodes.has(this.code);
  }
  get retryable(): boolean {
    return temporaryCodes.has(this.code) || this.status === 503;
  }
}

export function safeSubscriptionError(error: unknown): ChatGPTSubscriptionError {
  if (error instanceof ChatGPTSubscriptionError) return error;
  if (error instanceof Error && error.name === "AbortError")
    return new ChatGPTSubscriptionError("cancelled");
  return new ChatGPTSubscriptionError("network_error");
}

export function parseSubscriptionError(
  body: unknown,
  status: number,
  requestId?: string,
): ChatGPTSubscriptionError {
  const object = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const value =
    object.error && typeof object.error === "object"
      ? (object.error as Record<string, unknown>)
      : object;
  const rawCode = typeof object.error === "string" ? object.error : value.code;
  const code =
    typeof rawCode === "string" && /^[a-z][a-z0-9_]{0,100}$/u.test(rawCode)
      ? rawCode
      : status === 503
        ? "service_unavailable"
        : `http_${status}`;
  const safeRequestId =
    requestId && /^[a-zA-Z0-9_-]{1,200}$/u.test(requestId) ? requestId : undefined;
  return new ChatGPTSubscriptionError(code, status, safeRequestId);
}

/** 私有恢复信息不进入展示错误或 RPC schema。 */
export class SubscriptionRegistrationError extends ChatGPTSubscriptionError {
  constructor(
    error: ChatGPTSubscriptionError,
    readonly issuedClientId: string,
  ) {
    super(error.code, error.status, error.requestId);
  }
}
/** 只有明确令牌拒绝允许一次受管刷新；scope/资格/用量错误不能循环登录。 */
export function isSubscriptionTokenRejection(code: string): boolean {
  return [
    "http_401",
    "invalid_api_key",
    "token_expired",
    "access_token_expired",
    "invalid_token",
    "invalid_access_token",
  ].includes(code);
}
