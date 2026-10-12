// Modified by ZCode Feiyu.
import type { SubscriptionOAuthPort, SubscriptionStorePort } from "./ports.js";
interface LifecycleDependencies {
  store: SubscriptionStorePort;
  oauth: SubscriptionOAuthPort;
  publish(): Promise<void>;
  isStorageAvailable(): boolean;
  cancelAuthorization?(): void;
  invalidate?(profileId: string): void;
}
export async function cleanupRetiredSubscriptions(deps: LifecycleDependencies) {
  if (!deps.isStorageAvailable()) return;
  const state = await deps.store.read();
  for (const profile of state.profiles.filter(
    (p) => p.profileId !== state.activeProfileId && p.retiredAt && (p.tokens || p.pendingTokens),
  )) {
    const token = profile.pendingTokens?.refreshToken ?? profile.tokens?.refreshToken;
    let confirmed = !token;
    if (token) {
      try {
        await deps.oauth.revoke(profile.clientId, token);
        confirmed = true;
      } catch {
        confirmed = false;
      }
    }
    await deps.store.transaction(async (current, save) => {
      const p = current.profiles.find((p) => p.profileId === profile.profileId);
      if (
        !p ||
        p.credentialRevision !== profile.credentialRevision ||
        current.activeProfileId === p.profileId
      )
        return;
      delete p.tokens;
      delete p.pendingTokens;
      p.status = "signed-out";
      p.generation++;
      p.remoteRevocation = confirmed ? "confirmed" : "unconfirmed";
      current.revision++;
      await save(current);
    });
  }
  await deps.publish();
}

export async function signOutSubscription(deps: LifecycleDependencies, remove: boolean) {
  deps.cancelAuthorization?.();
  const state = await deps.store.read();
  const selected = state.profiles.find((p) => p.profileId === state.activeProfileId);
  if (!selected) return;
  deps.invalidate?.(selected.profileId);
  let revocationConfirmed = false;
  await deps.store.transaction(async (current, save) => {
    const p = current.profiles.find((p) => p.profileId === selected.profileId);
    if (!p) return;
    const token = p.pendingTokens?.refreshToken ?? p.tokens?.refreshToken;
    p.generation++;
    p.status = "signed-out";
    let confirmed = !token;
    if (token) {
      try {
        await deps.oauth.revoke(p.clientId, token);
        confirmed = true;
      } catch {
        confirmed = false;
      }
    }
    delete p.tokens;
    delete p.pendingTokens;
    p.remoteRevocation = confirmed ? "confirmed" : "unconfirmed";
    revocationConfirmed = confirmed;
    if (remove) {
      current.profiles = current.profiles.filter((row) => row.profileId !== p.profileId);
      current.activeProfileId = null;
    }
    current.revision++;
    await save(current);
  });
  await deps.publish();
  return revocationConfirmed;
}
