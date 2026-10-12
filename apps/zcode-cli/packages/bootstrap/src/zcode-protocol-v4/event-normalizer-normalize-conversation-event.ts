// Modified by ZCode Feiyu.
import type { SessionEvent, TurnStartedPayload, ModelStreamingPayload } from "@zcode/contracts";
import type {
  NormalizeConversationEventContext,
  CanonicalConversationFact,
} from "./event-normalizer-canonical-conversation-visibility.js";
import { runtimeTurnIdOf } from "./event-normalizer-canonical-conversation-visibility.js";
import { SessionEventType } from "@zcode/contracts";
import {
  normalizeTurnStarted,
  normalizeModelStreaming,
} from "./event-normalizer-normalize-turn-started.js";

/**
 * live SessionEvent 与 cold hydration 合成事件的唯一字段解释入口。
 *
 * 过去 ProductProjection 直接从 raw payload 分别猜 messageId、origin 与
 * visibility；cold 少一个字段时可见 row 仍会生成，但命令 target 缺失。normalizer
 * 先生成自包含 canonical fact，让 row、target、actions 使用同一份身份事实。
 */
export function normalizeConversationEvent(
  event: SessionEvent,
  context: NormalizeConversationEventContext = {},
): CanonicalConversationFact {
  const runtimeTurnId = runtimeTurnIdOf(event);
  const productTurnId = context.productTurnId ?? runtimeTurnId;
  if (event.type === SessionEventType.TurnStarted) {
    return normalizeTurnStarted(event, event.payload as TurnStartedPayload, {
      runtimeTurnId,
      productTurnId,
    });
  }
  if (event.type === SessionEventType.ModelStreaming) {
    return normalizeModelStreaming(event, event.payload as ModelStreamingPayload, {
      runtimeTurnId,
      productTurnId,
      openAssistantSegments: context.openAssistantSegments,
    });
  }
  if (
    event.type === SessionEventType.CompactStarted ||
    event.type === SessionEventType.CompactCompleted ||
    event.type === SessionEventType.CompactFailed
  ) {
    const payload = event.payload as Record<string, unknown>;
    const operationId =
      typeof payload.operationId === "string" && payload.operationId.length > 0
        ? payload.operationId
        : String(event.id);
    const transcriptMessageId =
      typeof payload.messageId === "string" && payload.messageId.length > 0
        ? payload.messageId
        : null;
    return {
      semanticKind: "passthrough",
      event,
      entityId: operationId,
      productTurnId,
      runtimeTurnId,
      transcriptMessageId,
      visibility: "visible",
      origin: "system",
      placement: { lane: "assistantWork", relation: "withinProductTurn" },
      diagnostics: [],
      ...(typeof payload.sourceCommandId === "string"
        ? { sourceCommandId: payload.sourceCommandId }
        : {}),
    };
  }
  return {
    semanticKind: "passthrough",
    event,
    entityId: String(event.id),
    productTurnId,
    runtimeTurnId,
    transcriptMessageId: null,
    visibility: "stateOnly",
    origin: "system",
    placement: { lane: "stateOnly", relation: "none" },
    diagnostics: [],
  };
}
