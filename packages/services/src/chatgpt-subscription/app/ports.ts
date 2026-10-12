// Modified by ZCode Feiyu.
import type { SubscriptionStore, SubscriptionTokens } from "../domain/records.js";

export interface SubscriptionCipher {
  id: string;
  available(): boolean;
  encrypt(value: string): Promise<string>;
  decrypt(value: string): Promise<string>;
}
export interface SubscriptionStorePort {
  hostId(): Promise<string>;
  read(): Promise<SubscriptionStore>;
  transaction<T>(
    run: (
      current: SubscriptionStore,
      save: (next: SubscriptionStore) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
}
export interface VerifiedSubscriptionIdentity {
  issuer: string;
  subject: string;
  email?: string;
}
export interface SubscriptionOAuthPort {
  authorize(input: {
    hostId: string;
    clientId?: string;
    idTokenHint?: string;
    loginHint?: string;
    enableUsage: boolean;
    signal: AbortSignal;
  }): Promise<{
    clientId: string;
    identity: VerifiedSubscriptionIdentity;
    tokens: SubscriptionTokens;
  }>;
  refresh(
    clientId: string,
    previous: SubscriptionTokens,
    signal?: AbortSignal,
  ): Promise<SubscriptionTokens>;
  verify(
    idToken: string,
    clientId: string,
    nonce?: string,
    signal?: AbortSignal,
  ): Promise<VerifiedSubscriptionIdentity>;
  revoke(clientId: string, refreshToken: string, signal?: AbortSignal): Promise<void>;
}
