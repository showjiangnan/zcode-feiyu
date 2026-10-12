// Modified by ZCode Feiyu.
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { tokenSetSchema, type SubscriptionTokens } from "../domain/records.js";
import { ChatGPTSubscriptionError, parseSubscriptionError } from "../domain/errors.js";
import type { VerifiedSubscriptionIdentity } from "../app/ports.js";

export const OPENAI_SUBSCRIPTION_RESOURCE = "https://api.openai.com/v1";
export const OPENAI_SUBSCRIPTION_ISSUER = "https://auth.openai.com";
export const OPENAI_SUBSCRIPTION_SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint: string;
}

/** 生产装配固定 issuer；测试用独立实例注入模拟 OIDC，不接收供应商配置。 */
export class SubscriptionOAuthNetwork {
  private discoveryPromise?: Promise<Discovery>;
  constructor(
    private readonly fetcher: typeof fetch,
    private readonly issuer = OPENAI_SUBSCRIPTION_ISSUER,
  ) {}

  async discovery(): Promise<Discovery> {
    if (!this.discoveryPromise) {
      const pending = this.loadDiscovery();
      this.discoveryPromise = pending;
      void pending.catch(() => {
        if (this.discoveryPromise === pending) this.discoveryPromise = undefined;
      });
    }
    return this.discoveryPromise;
  }

  private async loadDiscovery(): Promise<Discovery> {
    const response = await this.fetcher(`${this.issuer}/.well-known/openid-configuration`, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new ChatGPTSubscriptionError("discovery_unavailable", response.status);
    const value = (await response.json()) as Partial<Discovery>;
    if (value.issuer !== this.issuer)
      throw new ChatGPTSubscriptionError("discovery_issuer_invalid");
    for (const key of [
      "authorization_endpoint",
      "token_endpoint",
      "jwks_uri",
      "revocation_endpoint",
    ] as const) {
      const url = new URL(value[key] ?? "");
      if (url.origin !== this.issuer || url.username || url.password || url.hash)
        throw new ChatGPTSubscriptionError("discovery_endpoint_invalid");
    }
    return value as Discovery;
  }

  async verify(
    idToken: string,
    clientId: string,
    nonce?: string,
    signal?: AbortSignal,
  ): Promise<VerifiedSubscriptionIdentity> {
    try {
      const discovery = await this.discovery();
      const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri), {
        [customFetch]: (input, init) =>
          this.fetcher(input, {
            ...init,
            redirect: "error",
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : init?.signal,
          }),
        timeoutDuration: 30_000,
      });
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: this.issuer,
        audience: clientId,
        algorithms: ["RS256", "ES256"],
        requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
        clockTolerance: 5,
      });
      signal?.throwIfAborted();
      if (payload.iat! > Date.now() / 1000 + 5)
        throw new ChatGPTSubscriptionError("identity_token_invalid");
      if (nonce !== undefined && payload.nonce !== nonce)
        throw new ChatGPTSubscriptionError("identity_nonce_invalid");
      if (typeof payload.sub !== "string" || !payload.sub)
        throw new ChatGPTSubscriptionError("identity_subject_invalid");
      return {
        issuer: this.issuer,
        subject: payload.sub,
        ...(typeof payload.email === "string" ? { email: payload.email } : {}),
      };
    } catch (error) {
      if (signal?.aborted) throw new ChatGPTSubscriptionError("cancelled");
      if (error instanceof ChatGPTSubscriptionError) throw error;
      const code = (error as { code?: string }).code;
      if (code === "ERR_JWKS_TIMEOUT" || error instanceof TypeError)
        throw new ChatGPTSubscriptionError("identity_verification_unavailable");
      throw new ChatGPTSubscriptionError("identity_token_invalid");
    }
  }

  async exchange(
    values: Record<string, string>,
    signal?: AbortSignal,
    previous?: SubscriptionTokens,
  ): Promise<SubscriptionTokens> {
    const config = await this.discovery();
    const response = await this.fetcher(config.token_endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...values, resource: OPENAI_SUBSCRIPTION_RESOURCE }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok)
      throw parseSubscriptionError(
        data,
        response.status,
        response.headers.get("x-request-id") ?? undefined,
      );
    if (data.token_type !== "Bearer") throw new ChatGPTSubscriptionError("invalid_token_response");
    const scopes =
      typeof data.scope === "string" ? data.scope.split(/\s+/u).filter(Boolean) : previous?.scopes;
    const idToken = typeof data.id_token === "string" ? data.id_token : previous?.idToken;
    const sharing = scopes?.includes("chatgpt.tokens.use.direct");
    if (
      !scopes ||
      !idToken ||
      (data.token_type !== undefined && data.token_type !== "Bearer") ||
      (sharing &&
        (typeof data.access_token !== "string" ||
          !data.access_token ||
          typeof data.refresh_token !== "string" ||
          !data.refresh_token)) ||
      (data.access_token && (typeof data.expires_in !== "number" || data.expires_in <= 0))
    )
      throw new ChatGPTSubscriptionError("invalid_token_response");
    const rawEarliest = data.earliest_refresh_at;
    const earliest =
      typeof rawEarliest === "number"
        ? rawEarliest * 1000
        : typeof rawEarliest === "string"
          ? /^\d+(?:\.\d+)?$/u.test(rawEarliest)
            ? Number(rawEarliest) * 1000
            : Date.parse(rawEarliest)
          : undefined;
    return tokenSetSchema.parse({
      idToken,
      scopes,
      expiresAt: Date.now() + (typeof data.expires_in === "number" ? data.expires_in * 1000 : 0),
      ...(typeof data.access_token === "string" ? { accessToken: data.access_token } : {}),
      ...(typeof data.refresh_token === "string" ? { refreshToken: data.refresh_token } : {}),
      ...(earliest !== undefined && Number.isFinite(earliest)
        ? { earliestRefreshAt: earliest }
        : {}),
      ...(previous && typeof data.id_token === "string"
        ? { identityVerificationRequired: true }
        : {}),
    });
  }

  async revoke(clientId: string, refreshToken: string, signal?: AbortSignal): Promise<void> {
    const discovery = await this.discovery();
    const response = await this.fetcher(discovery.revocation_endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        token: refreshToken,
        token_type_hint: "refresh_token",
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    if (response.status !== 200)
      throw new ChatGPTSubscriptionError("revocation_unconfirmed", response.status);
    await response.body?.cancel();
  }
}
