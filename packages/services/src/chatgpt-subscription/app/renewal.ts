// Modified by ZCode Feiyu.
import { ChatGPTSubscriptionError } from "../domain/errors.js";
import { hasSubscriptionPermission, type SubscriptionProfile } from "../domain/records.js";
import type { SubscriptionOAuthPort, SubscriptionStorePort } from "./ports.js";

/** 文件事务覆盖整个轮换，主/子 Agent 和多 Host 不各自持有 renewable session。 */
export async function renewSubscriptionCredentials(
  deps: {
    store: SubscriptionStorePort;
    oauth: SubscriptionOAuthPort;
    assertGeneration(profile: SubscriptionProfile): void;
  },
  profileId: string,
  generation: number,
  signal?: AbortSignal,
  forceRefreshAtRevision?: number,
): Promise<SubscriptionProfile> {
  return deps.store.transaction(async (current, save) => {
    const profile = current.profiles.find((p) => p.profileId === profileId);
    if (!profile || profile.generation !== generation)
      throw new ChatGPTSubscriptionError("connection_generation_changed");
    deps.assertGeneration(profile);
    const commit = async (checkGeneration = true) => {
      if (checkGeneration) deps.assertGeneration(profile);
      current.revision += 1;
      await save(current);
    };
    const verifyPending = async () => {
      const tokens = profile.pendingTokens;
      if (!tokens) return;
      try {
        if (tokens.identityVerificationRequired) {
          const identity = await deps.oauth.verify(
            tokens.idToken,
            profile.clientId,
            undefined,
            signal,
          );
          if (identity.issuer !== profile.issuer || identity.subject !== profile.subject)
            throw new ChatGPTSubscriptionError("identity_changed");
        }
        deps.assertGeneration(profile);
        profile.tokens = { ...tokens, identityVerificationRequired: false };
        delete profile.pendingTokens;
        profile.status = hasSubscriptionPermission(profile.tokens) ? "connected" : "identity-only";
        await commit();
      } catch (error) {
        // 用户退出/取消与网络故障不是身份验证失败，保留轮换结果供退出事务撤销。
        if (
          signal?.aborted ||
          (error instanceof ChatGPTSubscriptionError &&
            (error.retryable || error.code === "connection_signed_out"))
        )
          throw error;
        delete profile.tokens;
        delete profile.pendingTokens;
        profile.status = "reauthorization-required";
        await commit();
        throw error;
      }
    };
    await verifyPending();
    if (profile.status !== "connected" || !hasSubscriptionPermission(profile.tokens))
      throw new ChatGPTSubscriptionError("subscription_permission_required");
    const previous = profile.tokens!;
    if (
      previous.expiresAt > Date.now() + 60_000 &&
      (forceRefreshAtRevision === undefined || profile.credentialRevision > forceRefreshAtRevision)
    )
      return profile;
    if (previous.earliestRefreshAt && previous.earliestRefreshAt > Date.now()) {
      if (previous.expiresAt > Date.now()) return profile;
      throw new ChatGPTSubscriptionError("refresh_not_yet_available");
    }
    if (!previous.refreshToken) throw new ChatGPTSubscriptionError("reauthorization_required");
    let next;
    try {
      next = await deps.oauth.refresh(profile.clientId, previous, signal);
    } catch (error) {
      if (error instanceof ChatGPTSubscriptionError && error.terminalRefresh) {
        delete profile.tokens;
        delete profile.pendingTokens;
        profile.status = "reauthorization-required";
        await commit();
      }
      throw error;
    }
    // 轮换成功后先保存 pending 集；JWKS 临时故障不能导致重用已消费的 refresh token。
    profile.pendingTokens = next;
    profile.status = "verification-pending";
    profile.credentialRevision += 1;
    // 退出可在网络等待期间到达；仍先保存已消费的轮换结果，随后拒绝使用。
    await commit(false);
    deps.assertGeneration(profile);
    await verifyPending();
    if (!hasSubscriptionPermission(profile.tokens))
      throw new ChatGPTSubscriptionError("subscription_permission_required");
    return profile;
  });
}
