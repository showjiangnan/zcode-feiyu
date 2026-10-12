// Modified by ZCode Feiyu.
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/client";
import type { ZCodeMcpAuthorizationCodeProvider } from "./oauth-authorization-owner.js";
import { CredentialSnapshot, StoredCredentialPair } from "./oauth-authorization-state.js";
import {
  deriveCredentialPair,
  isCanonicalCredentials,
  isRecord,
  MCP_OAUTH_CANONICAL_CREDENTIALS_KEY,
  MCP_OAUTH_SUPPORTED_CREDENTIAL_VERSIONS,
  type McpOAuthCanonicalCredentials,
} from "./oauth-credentials.js";

export async function invalidateCredentialSnapshot(
  this: ZCodeMcpAuthorizationCodeProvider,
  scope: "all" | "client" | "tokens",
): Promise<void> {
  await this.loadCredentialSnapshots();
  const canonicalSnapshot = this.canonicalSnapshot;
  const expectedValues: Record<string, string> = {};
  if (canonicalSnapshot) {
    expectedValues[this.key(MCP_OAUTH_CANONICAL_CREDENTIALS_KEY)] = canonicalSnapshot.raw;
  }
  if ((scope === "all" || scope === "client") && this.legacyClientSnapshot) {
    expectedValues[this.key("client_information")] = this.legacyClientSnapshot.raw;
  }
  if ((scope === "all" || scope === "client" || scope === "tokens") && this.legacyTokensSnapshot) {
    expectedValues[this.key("tokens")] = this.legacyTokensSnapshot.raw;
  }
  const deleted = await this.credentialStore.deleteIfValues(expectedValues);
  const canonicalDeleted = canonicalSnapshot
    ? deleted[this.key(MCP_OAUTH_CANONICAL_CREDENTIALS_KEY)]
    : undefined;
  this.logger?.warn("MCP OAuth credential snapshot invalidation resolved", {
    event: "mcp.oauth.credentials.invalidate_snapshot",
    ...this.logContext(),
    canonicalDeleted,
    // canonicalDeleted=false 表示 compare-and-delete 失败：另一个事务已发布新 pair，
    // 本次失效必须保留 winner。这是并发收口的正常结果，不是错误。
    hadCanonicalSnapshot: Boolean(canonicalSnapshot),
    invalidationScope: scope,
    legacyClientDeleted: deleted[this.key("client_information")],
    legacyTokensDeleted: deleted[this.key("tokens")],
    status: canonicalDeleted === false ? "cancelled" : "completed",
  });

  if (scope === "all" || scope === "client") {
    this.transactionClientInformation = undefined;
    this.transactionClientSource = undefined;
  } else if (
    this.transactionClientSource === "canonical" ||
    (canonicalSnapshot && this.transactionClientSource === "legacy")
  ) {
    if (canonicalDeleted === false) {
      // 修复原因：当前快照已被其他进程替换时，失败方不能删除新 pair；清空本地缓存，
      // 让 SDK 的同一次重试重新读取获胜事务发布的 client/tokens。
      this.transactionClientInformation = undefined;
      this.transactionClientSource = undefined;
    } else if (canonicalDeleted === true) {
      // token 已失效但动态 client 仍可用于当前 provider 重新授权。
      this.transactionClientSource = "registered";
    }
  }

  this.resetCredentialSnapshots();
}

export async function loadCredentialSnapshots(
  this: ZCodeMcpAuthorizationCodeProvider,
): Promise<void> {
  if (this.credentialSnapshotsLoaded) return;
  const canonicalKey = this.key(MCP_OAUTH_CANONICAL_CREDENTIALS_KEY);
  const legacyClientKey = this.key("client_information");
  const legacyTokensKey = this.key("tokens");
  const values = await this.credentialStore.loadMany([
    canonicalKey,
    legacyClientKey,
    legacyTokensKey,
  ]);
  const parsedCanonicalSnapshot = await this.parseJsonSnapshot<McpOAuthCanonicalCredentials>(
    canonicalKey,
    values[canonicalKey],
  );
  let canonicalSnapshot: CredentialSnapshot<McpOAuthCanonicalCredentials> | undefined;
  if (
    parsedCanonicalSnapshot &&
    isRecord(parsedCanonicalSnapshot.value) &&
    typeof parsedCanonicalSnapshot.value.version === "number" &&
    !MCP_OAUTH_SUPPORTED_CREDENTIAL_VERSIONS.has(parsedCanonicalSnapshot.value.version)
  ) {
    // 修复原因：CLI 与 desktop 会独立升级但共享凭据文件。旧版本只能忽略未知版本，
    // 不能把新版本写入的 canonical pair 当损坏数据删除。
  } else if (parsedCanonicalSnapshot && !isCanonicalCredentials(parsedCanonicalSnapshot.value)) {
    await this.credentialStore.deleteIfValue(canonicalKey, parsedCanonicalSnapshot.raw);
  } else {
    canonicalSnapshot = parsedCanonicalSnapshot;
  }
  const legacyClientSnapshot = await this.parseJsonSnapshot<OAuthClientInformationMixed>(
    legacyClientKey,
    values[legacyClientKey],
  );
  const legacyTokensSnapshot = await this.parseJsonSnapshot<OAuthTokens>(
    legacyTokensKey,
    values[legacyTokensKey],
  );

  // 修复原因：共享凭据读取可能因锁超时或临时 I/O 失败而抛错。只有完整快照成功后
  // 才发布缓存和 loaded 标志，确保同一个 provider 的下一次调用仍会重试。
  this.canonicalSnapshot = canonicalSnapshot;
  this.legacyClientSnapshot = legacyClientSnapshot;
  this.legacyTokensSnapshot = legacyTokensSnapshot;
  this.credentialSnapshotsLoaded = true;
}

export async function parseJsonSnapshot<T>(
  this: ZCodeMcpAuthorizationCodeProvider,
  key: string,
  raw: string | null | undefined,
): Promise<CredentialSnapshot<T> | undefined> {
  if (!raw) return undefined;
  try {
    return { raw, value: JSON.parse(raw) as T };
  } catch {
    await this.credentialStore.deleteIfValue(key, raw);
    return undefined;
  }
}

export async function loadStoredCredentialPair(
  this: ZCodeMcpAuthorizationCodeProvider,
): Promise<StoredCredentialPair | undefined> {
  if (this.storedCredentialPairLoaded) return this.storedCredentialPair;
  await this.loadCredentialSnapshots();
  // 委托给共享的纯函数：canonical 与 legacy 镜像的交错兼容规则只能有一份，两处各写一遍必然
  // 发散。用已经读到的快照派生，不再多读一次凭据文件；快照本身仍留在本类里，因为
  // compare-and-delete 需要发起方读到的原始值。
  const pair = deriveCredentialPair({
    canonicalRaw: this.canonicalSnapshot?.raw,
    legacyClientRaw: this.legacyClientSnapshot?.raw,
    legacyTokensRaw: this.legacyTokensSnapshot?.raw,
  });
  this.storedCredentialPair = pair
    ? {
        ...(pair.clientInformation ? { clientInformation: pair.clientInformation } : {}),
        source: pair.source,
        ...(pair.tokens ? { tokens: pair.tokens } : {}),
      }
    : undefined;
  this.storedCredentialPairLoaded = true;
  return this.storedCredentialPair;
}

export function resetCredentialSnapshots(this: ZCodeMcpAuthorizationCodeProvider): void {
  this.canonicalSnapshot = undefined;
  this.credentialSnapshotsLoaded = false;
  this.legacyClientSnapshot = undefined;
  this.legacyTokensSnapshot = undefined;
  this.storedCredentialPair = undefined;
  this.storedCredentialPairLoaded = false;
}

export async function loadJson<T>(
  this: ZCodeMcpAuthorizationCodeProvider,
  name: string,
): Promise<T | undefined> {
  const raw = await this.credentialStore.load(this.key(name));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    await this.credentialStore.deleteIfValue(this.key(name), raw);
    return undefined;
  }
}

export async function saveJson(
  this: ZCodeMcpAuthorizationCodeProvider,
  name: string,
  value: unknown,
): Promise<void> {
  await this.credentialStore.save(this.key(name), JSON.stringify(value));
}
