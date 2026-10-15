// Modified by ZCode Feiyu.
import { safeSubscriptionIncompleteReason } from "@zcode/shared";

const messages: Record<string, string> = {
  invalid_value: "unsupported",
  unsupported_value: "unsupported",
  unsupported_parameter: "unsupported",
  subscription_permission_required: "usageAuthorization",
  reauthorization_required: "reconnectError",
  subscription_sharing_user_not_eligible: "notEligible",
  subscription_sharing_usage_limit_exceeded: "usageLimit",
  subscription_sharing_usage_unavailable: "temporary",
  subscription_sharing_user_unavailable: "temporary",
  subscription_sharing_unsupported_capability: "unsupported",
  subscription_sharing_route_not_supported: "unsupported",
  subscription_sharing_invalid_user: "reconnectError",
  subscription_usage_not_authorized: "usageAuthorization",
  subscription_usage_confirmation_required: "usageAuthorization",
  connection_generation_changed: "connectionChanged",
  connection_not_active: "connectionChanged",
  connection_signed_out: "reconnectError",
  invalid_client: "registrationInvalid",
  revocation_unconfirmed: "revocationUnconfirmed",
  secure_storage_unavailable: "secureStorageUnavailable",
  credential_store_unavailable: "credentialStoreUnavailable",
  model_not_available: "modelUnavailable",
  response_incomplete: "interrupted",
  stream_interrupted: "interrupted",
  authorization_cancelled: "cancelledError",
  authorization_timeout: "timeoutError",
  network_error: "temporary",
  subscription_service_unavailable: "temporary",
};
export function subscriptionErrorMessageKey(
  code: string,
  incompleteReason?: string,
): string | undefined {
  if (code === "response_incomplete") {
    const reasons: Record<string, string> = {
      max_output_tokens: "interruptedBudget",
      content_filter: "interruptedFilter",
      max_messages: "interruptedMessages",
      steered: "interruptedSteered",
    };
    const safe = safeSubscriptionIncompleteReason(incompleteReason);
    if (safe && reasons[safe]) return reasons[safe];
  }
  return (
    messages[code] ??
    (/^(?:invalid_refresh_token|refresh_token_(?:expired|invalidated|reused)|invalid_grant|token_expired)$/u.test(
      code,
    )
      ? "reconnectError"
      : undefined)
  );
}
/** 只识别明确的安全订阅机器码，不根据通用 403/429 猜测计费来源。 */
export function subscriptionErrorCode(error: {
  code?: string;
  message: string;
  detail?: string;
  attribution?: { providerErrorCode?: string };
}): string | undefined {
  if (error.attribution?.providerErrorCode && messages[error.attribution.providerErrorCode])
    return error.attribution.providerErrorCode;
  if (error.code && messages[error.code]) return error.code;
  const text = `${error.message} ${error.detail ?? ""}`;
  return (
    text.match(/\b(subscription_sharing_[a-z_]+|subscription_usage_[a-z_]+)\b/u)?.[1] ??
    text.match(/ChatGPT subscription: ([a-z_]+)/u)?.[1]
  );
}

export function subscriptionIncompleteReason(error: {
  message: string;
  detail?: string;
  attribution?: { providerIncompleteReason?: string };
}): string | undefined {
  return (
    safeSubscriptionIncompleteReason(error.attribution?.providerIncompleteReason) ??
    safeSubscriptionIncompleteReason(
      `${error.message} ${error.detail ?? ""}`.match(
        /\bincomplete_reason=([a-z][a-z0-9_]{0,63})\b/u,
      )?.[1],
    )
  );
}
