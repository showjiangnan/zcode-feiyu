// Modified by ZCode Feiyu.
import { randomUUID } from "node:crypto";
import type { SubscriptionStorePort } from "./ports.js";
import type { SubscriptionProfile } from "../domain/records.js";
import {
  ChatGPTSubscriptionError,
  parseSubscriptionError,
  safeSubscriptionError,
  isSubscriptionTokenRejection,
} from "../domain/errors.js";
import { parseSubscriptionCatalog } from "../domain/catalog.js";

export async function refreshSubscriptionCatalog(deps: {
  store: SubscriptionStorePort;
  credentials(
    profileId: string,
    generation: number,
    signal?: AbortSignal,
    forceRefreshAtRevision?: number,
  ): Promise<SubscriptionProfile>;
  fetch: typeof fetch;
  catalogAttempts: Map<string, string>;
  assertGeneration(profile: SubscriptionProfile): void;
  publish(): Promise<void>;
  registerRequest(profileId: string, controller: AbortController): () => void;
}) {
  const state = await deps.store.read();
  const selected = state.profiles.find((p) => p.profileId === state.activeProfileId);
  if (!selected) throw new ChatGPTSubscriptionError("connection_missing");
  const attempt = randomUUID();
  deps.catalogAttempts.set(selected.profileId, attempt);
  const controller = new AbortController();
  const unregister = deps.registerRequest(selected.profileId, controller);
  try {
    let profile = await deps.credentials(
      selected.profileId,
      selected.generation,
      controller.signal,
    );
    const send = () =>
      deps.fetch("https://api.openai.com/v1/models", {
        headers: { authorization: `Bearer ${profile.tokens!.accessToken}` },
        redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      });
    let response = await send();
    if (response.status === 401) {
      const failure = parseSubscriptionError(
        await response.json().catch(() => ({})),
        response.status,
        response.headers.get("x-request-id") ?? undefined,
      );
      if (!isSubscriptionTokenRejection(failure.code)) throw failure;
      // 目录与推理必须共用轮换 owner，避免到期401只能靠重新登录恢复。
      profile = await deps.credentials(
        selected.profileId,
        selected.generation,
        controller.signal,
        profile.credentialRevision,
      );
      response = await send();
    }
    if (!response.ok)
      throw parseSubscriptionError(
        await response.json().catch(() => ({})),
        response.status,
        response.headers.get("x-request-id") ?? undefined,
      );
    const models = parseSubscriptionCatalog(await response.json());
    await deps.store.transaction(async (current, save) => {
      const p = current.profiles.find((p) => p.profileId === selected.profileId);
      if (
        !p ||
        p.generation !== selected.generation ||
        deps.catalogAttempts.get(p.profileId) !== attempt
      )
        return;
      deps.assertGeneration(p);
      p.models = models;
      p.catalogRevision++;
      p.catalogState = "fresh";
      delete p.catalogError;
      current.revision++;
      await save(current);
    });
  } catch (error) {
    const safe = safeSubscriptionError(error);
    await deps.store.transaction(async (current, save) => {
      const p = current.profiles.find((p) => p.profileId === selected.profileId);
      if (
        !controller.signal.aborted &&
        p &&
        p.generation === selected.generation &&
        deps.catalogAttempts.get(p.profileId) === attempt
      ) {
        p.catalogState = p.models.length ? "cached" : "failed";
        p.catalogError = safe.code;
        current.revision++;
        await save(current);
      }
    });
    throw safe;
  } finally {
    unregister();
    await deps.publish();
  }
}
