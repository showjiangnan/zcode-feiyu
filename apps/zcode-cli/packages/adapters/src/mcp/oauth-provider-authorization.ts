// Modified by ZCode Feiyu.
import type {
  OAuthClientInformationMixed,
  OAuthDiscoveryState,
  OAuthTokens,
} from "@modelcontextprotocol/client";
import type { ZCodeMcpAuthorizationCodeProvider } from "./oauth-authorization-owner.js";
import { hashIdentifier } from "./oauth-authorization-state.js";
import { publishCanonicalCredentials } from "./oauth-credentials.js";
import { createInteractiveAuthorizationRequiredError } from "./oauth-errors.js";
import { loadDiscoveryRecord, saveDiscoveryRecord } from "./oauth-shared.js";

export function state(this: ZCodeMcpAuthorizationCodeProvider): string {
  return this.stateValue;
}

export async function clientInformation(
  this: ZCodeMcpAuthorizationCodeProvider,
): Promise<OAuthClientInformationMixed | undefined> {
  if (this.config.clientId) {
    return {
      client_id: this.config.clientId,
      ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
    };
  }
  if (this.transactionClientInformation) {
    return this.transactionClientInformation;
  }

  const storedPair = await this.loadStoredCredentialPair();
  if (storedPair?.clientInformation) {
    this.transactionClientInformation = storedPair.clientInformation;
    this.transactionClientSource = storedPair.source;
    return this.transactionClientInformation;
  }

  // 修复原因（根因 2 的过渡 seam）：返回 undefined 会让 SDK 立刻做一次动态注册，而 DCR 的
  // 归属已经整体移交 Phase 2。没有 client 也就没有 refresh token，本来就只能交互授权，
  // 因此这里直接抛 interactiveRequired，避免在授权服务器上留下一个永不会被使用的注册。
  throw createInteractiveAuthorizationRequiredError({
    reason: "no_credentials",
    serverName: this.serverName,
  });
}

export async function saveClientInformation(
  this: ZCodeMcpAuthorizationCodeProvider,
  clientInformation: OAuthClientInformationMixed,
): Promise<void> {
  // 修复原因：MCP SDK 在 authorization code exchange 时会再次读取 provider。
  // 动态注册结果必须固定在当前 state 对应的 provider 实例；同时先写入 legacy client
  // 作为 provider 重建后的恢复种子。当前事务后续只读内存值，不会被并发注册覆盖。
  await this.credentialStore.save(
    this.key("client_information"),
    JSON.stringify(clientInformation),
  );
  this.transactionClientInformation = clientInformation;
  this.transactionClientSource = "registered";
}

export async function tokens(
  this: ZCodeMcpAuthorizationCodeProvider,
): Promise<OAuthTokens | undefined> {
  return (await this.loadStoredCredentialPair())?.tokens;
}

export async function saveTokens(
  this: ZCodeMcpAuthorizationCodeProvider,
  tokens: OAuthTokens,
): Promise<void> {
  const clientInformation = await this.clientInformation();
  if (!clientInformation) {
    throw new Error(`Missing MCP OAuth client information for ${this.serverName}`);
  }
  const previousTokens = this.storedCredentialPair?.tokens;
  // 通过共享 helper 发布，确保 Phase 2 与本 provider 写出的 canonical 形态完全一致
  // （含每次 publication 唯一的 generation）。client 与 refresh token 必须来自同一次授权，
  // 三个 key 仍在同一个跨进程 read-modify-write 临界区内原子写入。
  const published = await publishCanonicalCredentials(this.credentialStore, this.keyPrefix, {
    clientInformation,
    publishedBy: this.transactionId,
    tokens,
  });
  this.canonicalSnapshot = { raw: published.raw, value: published.canonical };
  this.legacyClientSnapshot = { raw: published.legacyClientRaw, value: clientInformation };
  this.legacyTokensSnapshot = { raw: published.legacyTokensRaw, value: tokens };
  this.credentialSnapshotsLoaded = true;
  this.storedCredentialPair = {
    clientInformation,
    source: "legacy",
    tokens,
  };
  this.storedCredentialPairLoaded = true;
  this.transactionClientSource = "canonical";
  // 修复原因：授权与刷新过去都没有成功侧事件，日志里只能看到 authorization.required，
  // 无法判断一次 refresh 到底成功过没有。只记录安全标识与形态，不记录任何 token 明文。
  this.logger?.info("MCP OAuth credentials published", {
    event: "mcp.oauth.credentials.published",
    ...this.logContext(),
    clientIdHash: hashIdentifier(clientInformation.client_id),
    grantKind: previousTokens ? "refresh" : "authorization_code",
    hasRefreshToken: Boolean(tokens.refresh_token),
    publishedGeneration: published.generation.slice(0, 12),
    refreshTokenRotated: Boolean(
      previousTokens?.refresh_token &&
      tokens.refresh_token &&
      previousTokens.refresh_token !== tokens.refresh_token,
    ),
    status: "completed",
    tokenExpiresInSeconds: tokens.expires_in,
  });
}

export async function redirectToAuthorization(
  this: ZCodeMcpAuthorizationCodeProvider,
  authorizationUrl: URL,
): Promise<void> {
  this.pendingAuthorization = true;
  // 修复原因（根因 2 的过渡 seam）：本 provider 复用持久化的 DCR client，而它的 redirect_uris
  // 锁死在注册当时的随机端口，`authorizationUrl` 因此可能带「旧 client_id + 新 redirect_uri」。
  // 授权服务器按 RFC 6749 §4.1.2.1 禁止回跳、就地渲染错误页，回调永不到达且重试永不自愈。
  // 所以这里不再投影该 URL、也不打开浏览器，而是抛出 interactiveRequired，由 adapter 编排层
  // 转入 Phase 2 的 fresh DCR 授权事务（见 docs/mcp-oauth-two-phase.md §4.7）。
  this.logger?.warn("MCP OAuth authorization handed off to interactive transaction", {
    event: "mcp.oauth.authorization.handoff",
    ...this.logContext(),
    callbackPort: Number(new URL(this.redirectUrl).port),
    status: "cancelled",
  });
  void authorizationUrl;
  throw createInteractiveAuthorizationRequiredError({
    reason: "legacy_provider_seam",
    serverName: this.serverName,
  });
}

export async function saveCodeVerifier(
  this: ZCodeMcpAuthorizationCodeProvider,
  codeVerifier: string,
): Promise<void> {
  await this.credentialStore.save(this.verifierKey(), codeVerifier);
  this.verifierPersisted = true;
}

export async function codeVerifier(this: ZCodeMcpAuthorizationCodeProvider): Promise<string> {
  const codeVerifier = await this.credentialStore.load(this.verifierKey());
  if (!codeVerifier) {
    throw new Error(`Missing MCP OAuth PKCE verifier for ${this.serverName}`);
  }
  this.verifierPersisted = true;
  return codeVerifier;
}

export async function saveDiscoveryState(
  this: ZCodeMcpAuthorizationCodeProvider,
  state: OAuthDiscoveryState,
): Promise<void> {
  // 与 Phase 2 共用同一份带时间戳的 discovery 记录：否则一侧刷新了 AS metadata，另一侧
  // 仍可能使用无 TTL 的旧缓存。
  await saveDiscoveryRecord(this.credentialStore, this.keyPrefix, state);
}

export async function discoveryState(
  this: ZCodeMcpAuthorizationCodeProvider,
): Promise<OAuthDiscoveryState | undefined> {
  return await loadDiscoveryRecord(this.credentialStore, this.keyPrefix);
}

export async function invalidateCredentials(
  this: ZCodeMcpAuthorizationCodeProvider,
  scope: "all" | "client" | "tokens" | "verifier" | "discovery",
) {
  // 修复原因：过去 refresh 失败只在 SDK 内部分类，ZCode 侧不留任何痕迹，事后无法区分
  // token 过期、被撤销、client mismatch 和服务端临时错误（见 docs/analysis 的可观测性缺口）。
  // SDK 不把 OAuth error code 传给 provider，但 invalidation scope 与之一一对应：
  // tokens ← invalid_grant；client/all ← invalid_client / unauthorized_client。
  this.logger?.warn("MCP OAuth credentials invalidated", {
    event: "mcp.oauth.credentials.invalidated",
    ...this.logContext(),
    invalidationScope: scope,
    status: "failed",
  });
  if (scope === "all" || scope === "client" || scope === "tokens") {
    await this.invalidateCredentialSnapshot(scope);
  }
  if (scope === "all" || scope === "verifier") {
    await this.clearVerifier();
  }
  if (scope === "all" || scope === "discovery") {
    await this.credentialStore.delete(this.key("discovery_state"));
  }
}

export function hasPendingAuthorization(this: ZCodeMcpAuthorizationCodeProvider): boolean {
  return this.pendingAuthorization;
}

export async function close(this: ZCodeMcpAuthorizationCodeProvider): Promise<void> {
  // 修复原因：PKCE verifier 只属于当前 state。adapter 超时或关闭时必须清理本事务，
  // 不能再删除相同 MCP 配置下另一个并发授权正在等待的 verifier。清理属于 best-effort：
  // token exchange 已成功时，锁超时或损坏文件不能把主链路反转成连接失败。
  try {
    await this.clearVerifier();
  } catch (error) {
    this.logger?.warn("MCP OAuth verifier cleanup failed", {
      event: "mcp.oauth.verifier.cleanup_failed",
      adapterInstanceId: this.adapterInstanceId,
      error: error instanceof Error ? error.message : String(error),
      mcpServerName: this.serverName,
      oauthStateId: this.transactionId.slice(0, 16),
      processId: process.pid,
      status: "failed",
    });
  }
  this.transactionClientInformation = undefined;
  this.transactionClientSource = undefined;
  this.resetCredentialSnapshots();
}

export function key(this: ZCodeMcpAuthorizationCodeProvider, name: string): string {
  return `${this.keyPrefix}:${name}`;
}

export function logContext(this: ZCodeMcpAuthorizationCodeProvider): Record<string, unknown> {
  return {
    adapterInstanceId: this.adapterInstanceId,
    credentialKeyPrefix: this.keyPrefix,
    mcpServerName: this.serverName,
    oauthStateId: this.transactionId.slice(0, 16),
    processId: process.pid,
  };
}

export function verifierKey(this: ZCodeMcpAuthorizationCodeProvider): string {
  return this.key(`code_verifier:${this.stateValue}`);
}

export async function clearVerifier(this: ZCodeMcpAuthorizationCodeProvider): Promise<void> {
  if (!this.verifierPersisted) return;
  await this.credentialStore.delete(this.verifierKey());
  this.verifierPersisted = false;
}
