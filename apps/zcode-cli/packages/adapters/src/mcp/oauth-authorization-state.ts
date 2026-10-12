// Modified by ZCode Feiyu.
import type {
  OAuthClientInformationMixed,
  OAuthClientProvider,
  OAuthTokens,
} from "@modelcontextprotocol/client";
import type { McpOAuthConfig } from "@zcode/contracts";
import { createHash } from "node:crypto";
import { type SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import { type McpOAuthAuthorizationContext } from "./oauth-shared.js";

export const DEFAULT_MCP_OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface CredentialSnapshot<T> {
  raw: string;
  value: T;
}

export interface StoredCredentialPair {
  clientInformation?: OAuthClientInformationMixed;
  source: "canonical" | "legacy";
  tokens?: OAuthTokens;
}

export type TransactionClientSource = "canonical" | "legacy" | "registered";

export type McpAuthorizationCodeOAuthConfig = Extract<
  McpOAuthConfig,
  { type: "authorization_code" }
>;

export type { McpOAuthAuthorizationContext };

export interface McpOAuthRuntimeOptions {
  authorizationTimeoutMs?: number;
  credentialStore?: SharedZCodeCredentialStore;
  onAuthorizationRequired?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
  openAuthorizationUrl?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
}

export interface McpOAuthSession {
  close(): Promise<void>;
  readonly provider: OAuthClientProvider;
  readonly timeoutMs: number;
  hasPendingAuthorization(): boolean;
  waitForAuthorizationCallback(): Promise<URLSearchParams>;
}

export /** 日志用脱敏摘要：client_id 等标识只记录哈希前缀，不记录原值。 */
function hashIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function normalizeCallbackPath(value: string | undefined, serverName: string): string {
  const fallback = `/oauth/callback/mcp/${encodeURIComponent(serverName)}`;
  if (!value) return fallback;
  return value.startsWith("/") ? value : `/${value}`;
}

export function createCredentialKeyPrefix(
  serverName: string,
  serverUrl: string,
  config: McpAuthorizationCodeOAuthConfig,
): string {
  // OAuth token 和动态 client 注册都依赖授权语义，scope/client/redirect 变化时必须重新授权。
  const hash = createHash("sha256")
    .update(
      [
        serverName,
        serverUrl,
        config.clientId ?? "",
        config.scope ?? "",
        config.redirectPath ?? "",
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 24);
  return `mcp:oauth:${hash}`;
}
