// Modified by ZCode Feiyu.
import type { Logger } from "@zcode/contracts";
import { randomBytes } from "node:crypto";
import { createLocalhostOAuthCallbackServer } from "../auth/localhost-callback.js";
import { createSharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import { ZCodeMcpAuthorizationCodeProvider } from "./oauth-authorization-owner.js";
import {
  createCredentialKeyPrefix,
  DEFAULT_MCP_OAUTH_CALLBACK_TIMEOUT_MS,
  normalizeCallbackPath,
  type McpAuthorizationCodeOAuthConfig,
  type McpOAuthRuntimeOptions,
  type McpOAuthSession,
} from "./oauth-authorization-state.js";
export {
  createCredentialKeyPrefix,
  type McpOAuthRuntimeOptions,
  type McpOAuthSession,
} from "./oauth-authorization-state.js";
export type { McpOAuthAuthorizationContext } from "./oauth-shared.js";
export async function createMcpAuthorizationCodeOAuthSession(input: {
  adapterInstanceId?: string;
  config: McpAuthorizationCodeOAuthConfig;
  logger?: Logger;
  options?: McpOAuthRuntimeOptions;
  serverName: string;
  serverUrl: string;
}): Promise<McpOAuthSession> {
  const state = randomBytes(24).toString("base64url");
  const callbackPath = normalizeCallbackPath(input.config.redirectPath, input.serverName);
  const callbackServer = await createLocalhostOAuthCallbackServer({
    callbackPath,
    state,
  });
  const credentialStore = input.options?.credentialStore ?? createSharedZCodeCredentialStore();
  const keyPrefix = createCredentialKeyPrefix(input.serverName, input.serverUrl, input.config);
  const provider = new ZCodeMcpAuthorizationCodeProvider({
    adapterInstanceId: input.adapterInstanceId,
    callbackServer,
    config: input.config,
    credentialStore,
    keyPrefix,
    logger: input.logger,
    onAuthorizationRequired: input.options?.onAuthorizationRequired,
    openAuthorizationUrl: input.options?.openAuthorizationUrl,
    serverName: input.serverName,
    state,
  });

  return {
    close: async () => {
      await callbackServer.close();
      await provider.close();
    },
    provider,
    timeoutMs: input.options?.authorizationTimeoutMs ?? DEFAULT_MCP_OAUTH_CALLBACK_TIMEOUT_MS,
    hasPendingAuthorization: () => provider.hasPendingAuthorization(),
    waitForAuthorizationCallback: async () => {
      const callback = await callbackServer.waitForCallback();
      return new URL(callback.url).searchParams;
    },
  };
}
