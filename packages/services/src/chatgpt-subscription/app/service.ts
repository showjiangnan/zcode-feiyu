// Modified by ZCode Feiyu.
import { cleanupRetiredSubscriptions, signOutSubscription } from "./lifecycle.js";
import { randomUUID } from "node:crypto";
import type {
  ChatGPTSubscriptionCommand,
  ChatGPTSubscriptionView,
  IChatGPTSubscriptionService,
} from "../contract.js";
import {
  ChatGPTSubscriptionError,
  safeSubscriptionError,
  SubscriptionRegistrationError,
} from "../domain/errors.js";
import { refreshSubscriptionCatalog } from "./catalog.js";
import { hasSubscriptionPermission, type SubscriptionProfile } from "../domain/records.js";
import type { SubscriptionOAuthPort, SubscriptionStorePort } from "./ports.js";
import { renewSubscriptionCredentials } from "./renewal.js";
import { resolveSubscriptionContextPlan } from "../domain/contextPlan.js";

export interface SubscriptionServiceDependencies {
  store: SubscriptionStorePort;
  oauth: SubscriptionOAuthPort;
  fetch: typeof fetch;
  publish(): Promise<void>;
  isStorageAvailable(): boolean;
}

export class ChatGPTSubscriptionService implements IChatGPTSubscriptionService {
  private pending: {
    attemptId: string;
    kind: "sign-in" | "switch" | "reauthorize";
    controller: AbortController;
  } | null = null;
  private lastError?: ChatGPTSubscriptionView["error"];
  private invalidated = new Set<string>();
  private readonly calls = new Map<string, Set<AbortController>>();
  private readonly catalogAttempts = new Map<string, string>();
  private disposed = false;
  private readonly bindings = new Map<string, { profileId: string; generation: number }>();
  constructor(private readonly deps: SubscriptionServiceDependencies) {}

  async execute(command: ChatGPTSubscriptionCommand): Promise<ChatGPTSubscriptionView> {
    if (this.disposed) throw new ChatGPTSubscriptionError("service_closed");
    switch (command.type) {
      case "read":
        return this.view();
      case "cancel":
        if (this.pending?.attemptId === command.attemptId) this.pending.controller.abort();
        break;
      case "sign-in": {
        if (!this.deps.isStorageAvailable())
          throw new ChatGPTSubscriptionError("secure_storage_unavailable");
        await this.deps.store.read(); // 损坏 store 在打开认证前拒绝，不覆盖既有连接。
        this.pending?.controller.abort();
        const pending = {
          attemptId: randomUUID(),
          kind: command.mode,
          controller: new AbortController(),
        };
        this.pending = pending;
        this.lastError = undefined;
        void this.signIn(pending, command.enableUsage === true)
          .catch((error) => {
            if (this.pending === pending) {
              const safe = safeSubscriptionError(error);
              this.lastError = { code: safe.code, status: safe.status, requestId: safe.requestId };
            }
          })
          .finally(() => {
            if (this.pending === pending) this.pending = null;
          });
        break;
      }
      case "refresh-models":
        await this.refreshModels();
        break;
      case "acknowledge-usage":
        await this.deps.store.transaction(async (state, save) => {
          const p = state.profiles.find((p) => p.profileId === state.activeProfileId);
          if (p) {
            p.usageAcknowledged = true;
            state.revision++;
            await save(state);
          }
        });
        break;
      case "sign-out":
        await this.signOut(false);
        break;
      case "remove":
        await this.signOut(true);
        break;
    }
    return this.view();
  }

  private async view(): Promise<ChatGPTSubscriptionView> {
    if (!this.deps.isStorageAvailable())
      return {
        revision: 0,
        available: false,
        unavailableReason: "secure_storage_unavailable",
        connection: null,
        pending: null,
      };
    const state = await this.deps.store.read();
    const p = state.profiles.find((p) => p.profileId === state.activeProfileId);
    return {
      revision: state.revision,
      available: true,
      connection: p
        ? {
            profileId: p.profileId,
            label: p.label,
            email: p.email,
            generation: p.generation,
            status: p.status,
            scopes: p.tokens?.scopes ?? [],
            models: p.models.map((model) => ({
              ...model,
              ...resolveSubscriptionContextPlan(model.slug),
            })),
            catalogRevision: p.catalogRevision,
            catalogState: p.catalogState,
            catalogError: p.catalogError,
            usageAcknowledged: p.usageAcknowledged,
            remoteRevocation: p.remoteRevocation,
          }
        : null,
      pending: this.pending ? { attemptId: this.pending.attemptId, kind: this.pending.kind } : null,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  private async signIn(
    pending: NonNullable<ChatGPTSubscriptionService["pending"]>,
    enableUsage: boolean,
  ) {
    const before = await this.deps.store.read();
    const selected = before.profiles.find((p) => p.profileId === before.activeProfileId);
    if (pending.kind === "reauthorize" && !selected)
      throw new ChatGPTSubscriptionError("connection_missing");
    const saved = pending.kind !== "switch" ? selected : undefined;
    const hostId = await this.deps.store.hostId();
    pending.controller.signal.throwIfAborted();
    const registration =
      before.pendingRegistration?.kind === pending.kind &&
      before.pendingRegistration.activeProfileId === before.activeProfileId
        ? before.pendingRegistration
        : undefined;
    const result = await this.deps.oauth
      .authorize({
        hostId,
        clientId: saved?.clientId ?? registration?.clientId,
        idTokenHint: saved?.tokens?.idToken,
        loginHint: saved?.email,
        enableUsage,
        signal: pending.controller.signal,
      })
      .catch(async (error) => {
        if (this.pending === pending && !pending.controller.signal.aborted) {
          await this.deps.store.transaction(async (state, save) => {
            if (state.activeProfileId !== before.activeProfileId) return;
            if (error instanceof SubscriptionRegistrationError)
              state.pendingRegistration = {
                clientId: error.issuedClientId,
                kind: pending.kind,
                activeProfileId: before.activeProfileId,
              };
            else if (error instanceof ChatGPTSubscriptionError && error.code === "invalid_client")
              delete state.pendingRegistration;
            else return;
            state.revision++;
            await save(state);
          });
        }
        throw error;
      });
    if (
      saved &&
      (result.clientId !== saved.clientId ||
        result.identity.issuer !== saved.issuer ||
        result.identity.subject !== saved.subject)
    ) {
      await this.revokeUnusedAuthorization(result.clientId, result.tokens.refreshToken);
      throw new ChatGPTSubscriptionError("identity_changed");
    }
    if (this.pending !== pending || pending.controller.signal.aborted || this.disposed) {
      await this.revokeUnusedAuthorization(result.clientId, result.tokens.refreshToken);
      throw new ChatGPTSubscriptionError("authorization_cancelled");
    }
    await this.deps.store
      .transaction(async (state, save) => {
        if (
          state.activeProfileId !== before.activeProfileId ||
          this.pending !== pending ||
          pending.controller.signal.aborted
        )
          throw new ChatGPTSubscriptionError("connection_generation_changed");
        const existing = saved && state.profiles.find((p) => p.profileId === saved.profileId);
        if (existing && existing.generation !== saved.generation)
          throw new ChatGPTSubscriptionError("connection_generation_changed");
        const profile: SubscriptionProfile = {
          profileId: existing?.profileId ?? randomUUID(),
          issuer: result.identity.issuer,
          subject: result.identity.subject,
          clientId: result.clientId,
          email: result.identity.email,
          label: existing?.label ?? `ChatGPT ${state.profiles.length + 1}`,
          generation:
            existing?.status === "connected"
              ? existing.generation
              : (existing?.generation ?? 0) + 1,
          credentialRevision: (existing?.credentialRevision ?? 0) + 1,
          authorizationStartedAt:
            existing?.status === "connected" ? existing.authorizationStartedAt : Date.now(),
          status: hasSubscriptionPermission(result.tokens) ? "connected" : "identity-only",
          tokens: result.tokens,
          models: existing?.models ?? [],
          catalogRevision: existing?.catalogRevision ?? 0,
          catalogState: existing?.models.length ? "cached" : "empty",
          usageAcknowledged: existing?.usageAcknowledged ?? false,
        };
        if (state.activeProfileId && state.activeProfileId !== profile.profileId) {
          const previous = state.profiles.find((p) => p.profileId === state.activeProfileId);
          if (previous) previous.retiredAt = Date.now();
        }
        state.profiles = [
          ...state.profiles.filter((p) => p.profileId !== profile.profileId),
          profile,
        ];
        state.activeProfileId = profile.profileId;
        delete state.pendingRegistration;
        state.revision++;
        await save(state);
        this.invalidated.delete(profile.profileId);
      })
      .catch(async (error) => {
        await this.revokeUnusedAuthorization(result.clientId, result.tokens.refreshToken);
        throw error;
      });
    await this.deps.publish();
    if (hasSubscriptionPermission(result.tokens)) await this.refreshModels();
  }

  private async revokeUnusedAuthorization(clientId: string, token?: string) {
    if (token) await this.deps.oauth.revoke(clientId, token).catch(() => undefined);
  }

  cleanupRetired() {
    return cleanupRetiredSubscriptions(this.deps);
  }

  private assertGeneration(profile: SubscriptionProfile) {
    if (this.disposed || this.invalidated.has(profile.profileId))
      throw new ChatGPTSubscriptionError("connection_signed_out");
  }

  async credentials(
    profileId: string,
    generation: number,
    signal?: AbortSignal,
    forceRefreshAtRevision?: number,
  ) {
    try {
      return await renewSubscriptionCredentials(
        { ...this.deps, assertGeneration: (p) => this.assertGeneration(p) },
        profileId,
        generation,
        signal,
        forceRefreshAtRevision,
      );
    } finally {
      await this.deps.publish();
    }
  }

  private refreshModels() {
    return refreshSubscriptionCatalog({
      ...this.deps,
      catalogAttempts: this.catalogAttempts,
      credentials: this.credentials.bind(this),
      registerRequest: this.registerRequest.bind(this),
      assertGeneration: (p) => this.assertGeneration(p),
    });
  }

  private async signOut(remove: boolean) {
    const confirmed = await signOutSubscription(
      {
        ...this.deps,
        cancelAuthorization: () => this.pending?.controller.abort(),
        invalidate: (profileId) => {
          this.invalidated.add(profileId);
          for (const c of this.calls.get(profileId) ?? []) c.abort();
        },
      },
      remove,
    );
    this.lastError = confirmed === false ? { code: "revocation_unconfirmed" } : undefined;
  }

  async bindExecution(
    profileId: string,
    generation: number,
    scope?: { id: string; startedAt: number; parentId?: string },
  ) {
    const state = await this.deps.store.read();
    const p = state.profiles.find((p) => p.profileId === profileId);
    if (!p || p.generation !== generation)
      throw new ChatGPTSubscriptionError("connection_generation_changed");
    this.assertGeneration(p);
    if (scope) {
      const previous = this.bindings.get(scope.id);
      if (previous && (previous.profileId !== profileId || previous.generation !== generation))
        throw new ChatGPTSubscriptionError("connection_binding_changed");
      const parent = scope.parentId ? this.bindings.get(scope.parentId) : undefined;
      const inherits = parent?.profileId === profileId && parent.generation === generation;
      // 退出后重连不能把尚未执行的旧准入输入自动绑定到新授权代际。
      if (
        !previous &&
        !inherits &&
        p.authorizationStartedAt !== undefined &&
        scope.startedAt < p.authorizationStartedAt
      )
        throw new ChatGPTSubscriptionError("connection_generation_changed");
      if (
        !previous &&
        !inherits &&
        state.activeProfileId !== profileId &&
        (!p.retiredAt || scope.startedAt >= p.retiredAt)
      )
        throw new ChatGPTSubscriptionError("connection_not_active");
      this.bindings.set(scope.id, { profileId, generation });
    } else if (state.activeProfileId !== profileId)
      throw new ChatGPTSubscriptionError("connection_not_active");
  }

  releaseExecution(id: string) {
    this.bindings.delete(id);
  }

  registerRequest(profileId: string, controller: AbortController): () => void {
    const set = this.calls.get(profileId) ?? new Set<AbortController>();
    this.calls.set(profileId, set);
    set.add(controller);
    return () => {
      set.delete(controller);
      if (!set.size) this.calls.delete(profileId);
    };
  }

  dispose() {
    this.disposed = true;
    this.pending?.controller.abort();
    for (const set of this.calls.values()) for (const c of set) c.abort();
    this.calls.clear();
  }
}
