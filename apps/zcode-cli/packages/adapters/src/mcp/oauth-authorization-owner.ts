// Modified by ZCode Feiyu.
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthTokens,
} from "@modelcontextprotocol/client";
import type { Logger } from "@zcode/contracts";
import { createHash } from "node:crypto";
import { type LocalhostOAuthCallbackServer } from "../auth/localhost-callback.js";
import { type SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import {
  CredentialSnapshot,
  McpAuthorizationCodeOAuthConfig,
  StoredCredentialPair,
  TransactionClientSource,
} from "./oauth-authorization-state.js";
import { type McpOAuthCanonicalCredentials } from "./oauth-credentials.js";
import * as oauth_provider_authorization from "./oauth-provider-authorization.js";
import * as oauth_provider_credentials from "./oauth-provider-credentials.js";
import { type McpOAuthAuthorizationContext } from "./oauth-shared.js";
// 授权与凭据职责拆分后仍绑定本实例，避免生成第二份 transaction 或 token 缓存。
export class ZCodeMcpAuthorizationCodeProvider implements OAuthClientProvider {
  readonly adapterInstanceId?: string;

  readonly callbackServer: LocalhostOAuthCallbackServer;

  readonly config: McpAuthorizationCodeOAuthConfig;

  readonly credentialStore: SharedZCodeCredentialStore;

  readonly keyPrefix: string;

  readonly logger?: Logger;

  readonly onAuthorizationRequired?: (
    context: McpOAuthAuthorizationContext,
  ) => Promise<void> | void;

  readonly openAuthorizationUrl?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;

  readonly serverName: string;

  readonly stateValue: string;

  readonly transactionId: string;

  canonicalSnapshot?: CredentialSnapshot<McpOAuthCanonicalCredentials>;

  credentialSnapshotsLoaded = false;

  legacyClientSnapshot?: CredentialSnapshot<OAuthClientInformationMixed>;

  legacyTokensSnapshot?: CredentialSnapshot<OAuthTokens>;

  storedCredentialPair?: StoredCredentialPair;

  storedCredentialPairLoaded = false;

  pendingAuthorization = false;

  transactionClientInformation?: OAuthClientInformationMixed;

  transactionClientSource?: TransactionClientSource;

  verifierPersisted = false;

  constructor(input: {
    adapterInstanceId?: string;
    callbackServer: LocalhostOAuthCallbackServer;
    config: McpAuthorizationCodeOAuthConfig;
    credentialStore: SharedZCodeCredentialStore;
    keyPrefix: string;
    logger?: Logger;
    onAuthorizationRequired?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
    openAuthorizationUrl?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
    serverName: string;
    state: string;
  }) {
    this.adapterInstanceId = input.adapterInstanceId;
    this.callbackServer = input.callbackServer;
    this.config = input.config;
    this.credentialStore = input.credentialStore;
    this.keyPrefix = input.keyPrefix;
    this.logger = input.logger;
    this.onAuthorizationRequired = input.onAuthorizationRequired;
    this.openAuthorizationUrl = input.openAuthorizationUrl;
    this.serverName = input.serverName;
    this.stateValue = input.state;
    this.transactionId = createHash("sha256").update(input.state).digest("hex");
  }

  get redirectUrl(): string {
    return this.callbackServer.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.config.clientName ?? `ZCode ${this.serverName}`,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.redirectUrl],
      response_types: ["code"],
      ...(this.config.clientSecret ? { token_endpoint_auth_method: "client_secret_basic" } : {}),
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    };
  }
  state(): string {
    return oauth_provider_authorization.state.call(this);
  }
  clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return oauth_provider_authorization.clientInformation.call(this);
  }
  saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    return oauth_provider_authorization.saveClientInformation.call(this, clientInformation);
  }
  tokens(): Promise<OAuthTokens | undefined> {
    return oauth_provider_authorization.tokens.call(this);
  }
  saveTokens(tokens: OAuthTokens): Promise<void> {
    return oauth_provider_authorization.saveTokens.call(this, tokens);
  }
  redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    return oauth_provider_authorization.redirectToAuthorization.call(this, authorizationUrl);
  }
  saveCodeVerifier(codeVerifier: string): Promise<void> {
    return oauth_provider_authorization.saveCodeVerifier.call(this, codeVerifier);
  }
  codeVerifier(): Promise<string> {
    return oauth_provider_authorization.codeVerifier.call(this);
  }
  saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    return oauth_provider_authorization.saveDiscoveryState.call(this, state);
  }
  discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return oauth_provider_authorization.discoveryState.call(this);
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    return oauth_provider_authorization.invalidateCredentials.call(this, scope);
  }
  hasPendingAuthorization(): boolean {
    return oauth_provider_authorization.hasPendingAuthorization.call(this);
  }
  close(): Promise<void> {
    return oauth_provider_authorization.close.call(this);
  }
  invalidateCredentialSnapshot(scope: "all" | "client" | "tokens"): Promise<void> {
    return oauth_provider_credentials.invalidateCredentialSnapshot.call(this, scope);
  }
  loadCredentialSnapshots(): Promise<void> {
    return oauth_provider_credentials.loadCredentialSnapshots.call(this);
  }
  parseJsonSnapshot<T>(
    key: string,
    raw: string | null | undefined,
  ): Promise<CredentialSnapshot<T> | undefined> {
    const parse = oauth_provider_credentials.parseJsonSnapshot<T>;
    return parse.call(this, key, raw);
  }
  loadStoredCredentialPair(): Promise<StoredCredentialPair | undefined> {
    return oauth_provider_credentials.loadStoredCredentialPair.call(this);
  }
  resetCredentialSnapshots(): void {
    return oauth_provider_credentials.resetCredentialSnapshots.call(this);
  }
  loadJson<T>(name: string): Promise<T | undefined> {
    const load = oauth_provider_credentials.loadJson<T>;
    return load.call(this, name);
  }
  saveJson(name: string, value: unknown): Promise<void> {
    return oauth_provider_credentials.saveJson.call(this, name, value);
  }
  key(name: string): string {
    return oauth_provider_authorization.key.call(this, name);
  }
  logContext(): Record<string, unknown> {
    return oauth_provider_authorization.logContext.call(this);
  }
  verifierKey(): string {
    return oauth_provider_authorization.verifierKey.call(this);
  }
  clearVerifier(): Promise<void> {
    return oauth_provider_authorization.clearVerifier.call(this);
  }
}
