// Modified by ZCode Feiyu.
import type { MessageWithParts } from "@zcode/contracts";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import type { HydrationBuffer } from "./v4-gateway-conversation-v4-gateway-options.js";
import type { ConversationV4Gateway } from "./v4-gateway.js";

export function hydratePublisher(
  this: ConversationV4Gateway,
  sessionId: string,
  persistedMessages?: MessageWithParts[],
  forceRebuild = false,
): Promise<ConversationTopicPublisher> {
  const existing = this["publishers"].get(sessionId);
  // 已 hydrate 过的 live publisher：直接复用（避免重复重建 / 双计）。
  if (existing && this["hydratedSessions"].has(sessionId)) return Promise.resolve(existing);
  const inFlight = this["hydrationInFlight"].get(sessionId);
  if (inFlight) return inFlight;
  const buffer: HydrationBuffer = {
    cancelled: false,
    eventIds: new Set<string>(),
    rawEvents: [],
  };
  this["hydrationBuffers"].set(sessionId, buffer);
  const hydration = this["performHydration"](
    sessionId,
    buffer,
    persistedMessages,
    forceRebuild,
  ).finally(() => {
    if (this["hydrationBuffers"].get(sessionId) === buffer) {
      this["hydrationBuffers"].delete(sessionId);
    }
    if (this["hydrationInFlight"].get(sessionId) === hydration) {
      this["hydrationInFlight"].delete(sessionId);
    }
  });
  this["hydrationInFlight"].set(sessionId, hydration);
  return hydration;
}
