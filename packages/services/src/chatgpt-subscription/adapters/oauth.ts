// Modified by ZCode Feiyu.
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { SubscriptionOAuthPort } from "../app/ports.js";
import {
  SubscriptionOAuthNetwork,
  OPENAI_SUBSCRIPTION_RESOURCE,
  OPENAI_SUBSCRIPTION_SCOPES,
} from "./oauthNetwork.js";
import { listenSubscriptionCallback } from "./oauthCallback.js";
import { safeSubscriptionError, SubscriptionRegistrationError } from "../domain/errors.js";

export function createSubscriptionOAuth(deps: {
  fetch: typeof fetch;
  openBrowser(url: string): Promise<void>;
  issuer?: string;
}): SubscriptionOAuthPort {
  const network = new SubscriptionOAuthNetwork(deps.fetch, deps.issuer);
  return {
    verify: (token, client, nonce, signal) => network.verify(token, client, nonce, signal),
    refresh: (client, previous, signal) =>
      network.exchange(
        {
          grant_type: "refresh_token",
          client_id: client,
          refresh_token: previous.refreshToken ?? "",
        },
        signal,
        previous,
      ),
    async revoke(client, token, signal) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await network.revoke(client, token, signal);
        } catch (error) {
          const safe = safeSubscriptionError(error);
          if (attempt >= 1 || !safe.retryable || signal?.aborted) throw safe;
          await delay(250, undefined, { signal });
        }
      }
    },
    async authorize(input) {
      const state = randomBytes(32).toString("base64url");
      const nonce = randomBytes(32).toString("base64url");
      const verifier = randomBytes(64).toString("base64url");
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(5 * 60_000)]);
      signal.throwIfAborted();
      const callback = await listenSubscriptionCallback(state, signal, input.clientId);
      let issuedClientId = input.clientId;
      let unusedRefreshToken: string | undefined;
      try {
        const discovery = await network.discovery();
        const url = new URL(discovery.authorization_endpoint);
        const parameters: Record<string, string> = {
          client_id: input.clientId ?? "dynamic_agent_client",
          ext_agent_host_id: input.hostId,
          response_type: "code",
          redirect_uri: callback.redirectUri,
          scope: OPENAI_SUBSCRIPTION_SCOPES,
          resource: OPENAI_SUBSCRIPTION_RESOURCE,
          state,
          nonce,
          code_challenge_method: "S256",
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          ...(!input.clientId ? { agent_name_hint: "ZCode Feiyu" } : {}),
          ...(input.clientId && input.idTokenHint ? { id_token_hint: input.idTokenHint } : {}),
          ...(input.clientId && input.loginHint ? { login_hint: input.loginHint } : {}),
          ...(input.enableUsage ? { prompt: "consent" } : {}),
        };
        for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
        signal.throwIfAborted();
        await deps.openBrowser(url.href);
        const result = await callback.result;
        issuedClientId = result.clientId;
        signal.throwIfAborted();
        const tokens = await network.exchange(
          {
            grant_type: "authorization_code",
            client_id: result.clientId,
            code: result.code,
            code_verifier: verifier,
            redirect_uri: callback.redirectUri,
          },
          signal,
        );
        unusedRefreshToken = tokens.refreshToken;
        const identity = await network.verify(tokens.idToken, result.clientId, nonce, signal);
        signal.throwIfAborted();
        return { clientId: result.clientId, identity, tokens };
      } catch (error) {
        if (issuedClientId && unusedRefreshToken)
          await network.revoke(issuedClientId, unusedRefreshToken).catch(() => undefined);
        const safe = safeSubscriptionError(error);
        if (issuedClientId && (safe.retryable || safe.code === "invalid_grant"))
          throw new SubscriptionRegistrationError(safe, issuedClientId);
        throw safe;
      } finally {
        await callback.close();
      }
    },
  };
}
