// Modified by ZCode Feiyu.
import type {
  CompactTimelineStatus as CompactTimelineStatusValue,
  MessagePart,
  MessageWithParts,
  TurnInputIntentMetadata,
} from "@zcode/contracts";
import { CompactTimelineStatus, CompactTrigger } from "@zcode/contracts";
import { highspeedMessageMetaSchema } from "@zcode/shared";
import { conversationInputIntentSchema } from "@zcode/shared/zcode-protocol-v4";

export function normalizeCompactTimelineStatus(
  status: string | undefined,
): CompactTimelineStatusValue | null {
  switch (status) {
    case CompactTimelineStatus.Started:
    case CompactTimelineStatus.Retrying:
    case CompactTimelineStatus.Skipped:
    case CompactTimelineStatus.Completed:
    case CompactTimelineStatus.Failed:
    case CompactTimelineStatus.Interrupted:
      return status;
    case "cancelled":
      return CompactTimelineStatus.Interrupted;
    default:
      return null;
  }
}

export function compactTriggerOfPart(part: Extract<MessagePart, { type: "compaction" }>) {
  return part.trigger ?? (part.auto ? CompactTrigger.Auto : CompactTrigger.Manual);
}

export function compactPayloadFromTimelinePart(part: Extract<MessagePart, { type: "timeline" }>) {
  if (part.timelineType !== "context_compaction") return null;
  const status = normalizeCompactTimelineStatus(part.status);
  if (!status) return null;
  return {
    status,
    payload: {
      operationId: part.operationId,
      messageId: String(part.messageID),
      partId: part.id,
      status,
      trigger: part.trigger,
      display: part.display,
      ...(part.sourceCommandId ? { sourceCommandId: part.sourceCommandId } : {}),
      ...(part.anchorMessageId ? { anchorMessageId: part.anchorMessageId } : {}),
      ...(part.anchorTurnId ? { anchorTurnId: part.anchorTurnId } : {}),
      ...(part.phase ? { phase: part.phase } : {}),
      ...(part.compactReason ? { compactReason: part.compactReason } : {}),
      ...(part.reason ? { reason: part.reason } : {}),
      ...(part.boundaryId ? { boundaryId: part.boundaryId } : {}),
      ...(part.summaryMessageId ? { summaryMessageId: part.summaryMessageId } : {}),
      ...(part.preCompactTokenCount !== undefined
        ? { preCompactTokenCount: part.preCompactTokenCount }
        : {}),
      ...(part.postCompactTokenCount !== undefined
        ? { postCompactTokenCount: part.postCompactTokenCount }
        : {}),
      ...(part.truePostCompactTokenCount !== undefined
        ? { truePostCompactTokenCount: part.truePostCompactTokenCount }
        : {}),
      ...(part.attempt !== undefined ? { attempt: part.attempt } : {}),
      ...(part.maxAttempts !== undefined ? { maxAttempts: part.maxAttempts } : {}),
      ...(part.time?.start !== undefined ? { startedAt: part.time.start } : {}),
      ...(part.time?.end !== undefined ? { endedAt: part.time.end } : {}),
    },
  };
}

export function compactPayloadFromLegacyCompactionPart(
  part: Extract<MessagePart, { type: "compaction" }>,
) {
  const status = normalizeCompactTimelineStatus(part.timelineStatus);
  if (!status) return null;
  return {
    status,
    payload: {
      operationId: part.operationId ?? part.boundaryId ?? `legacy-compact-${String(part.id)}`,
      messageId: String(part.messageID),
      partId: part.id,
      status,
      trigger: compactTriggerOfPart(part),
      display: part.timelineDisplay ?? "separator",
      ...(part.phase ? { phase: part.phase } : {}),
      ...(part.compactReason ? { compactReason: part.compactReason } : {}),
      ...(part.reason ? { reason: part.reason } : {}),
      ...(part.boundaryId ? { boundaryId: part.boundaryId } : {}),
      ...(part.summaryMessageId ? { summaryMessageId: part.summaryMessageId } : {}),
      ...(part.tail_start_id ? { tailStartMessageId: part.tail_start_id } : {}),
      ...(part.preCompactTokenCount !== undefined
        ? { preCompactTokenCount: part.preCompactTokenCount }
        : {}),
      ...(part.postCompactTokenCount !== undefined
        ? { postCompactTokenCount: part.postCompactTokenCount }
        : {}),
      ...(part.truePostCompactTokenCount !== undefined
        ? { truePostCompactTokenCount: part.truePostCompactTokenCount }
        : {}),
      ...(part.attempt !== undefined ? { attempt: part.attempt } : {}),
      ...(part.maxAttempts !== undefined ? { maxAttempts: part.maxAttempts } : {}),
      ...(part.time?.start !== undefined ? { startedAt: part.time.start } : {}),
      ...(part.time?.end !== undefined ? { endedAt: part.time.end } : {}),
    },
  };
}

export function parseJsonObject(input: string | undefined): Record<string, unknown> | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function stringField(
  source: Record<string, unknown> | undefined | null,
  key: string,
): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function inputIntentOfMessage(
  message: MessageWithParts,
): TurnInputIntentMetadata | undefined {
  const persistedHighspeed = highspeedMessageMetaSchema.safeParse(message.info.metadata?.highspeed);
  const fullIntent = conversationInputIntentSchema.safeParse(
    message.info.metadata?.conversationInputIntent,
  );
  if (fullIntent.success) {
    const value = fullIntent.data;
    return {
      sourceCommandId: value.sourceCommandId,
      ...(value.interTaskSourceTaskId
        ? { interTaskSourceTaskId: value.interTaskSourceTaskId }
        : {}),
      ...(value.causalContext ? { causalContext: value.causalContext } : {}),
      queueItemId: value.queueItemId,
      clientId: value.clientId,
      kind: value.kind,
      // 可见 text 是展示事实；goal 的 canonical objective 只能读取持久 intent.text，
      // 禁止从 `/goal replace ...` 文案再做大小写/关键字解析。
      text: value.text,
      ...(value.modelSelection ? { modelSelection: value.modelSelection } : {}),
      ...(value.mode ? { mode: value.mode } : {}),
      ...(value.planEnabled !== undefined ? { planEnabled: value.planEnabled } : {}),
      admissionSeq: value.order.admissionSeq,
      admittedAt: value.admittedAt,
      requestedDelivery: value.delivery.requested,
      admittedDelivery: value.delivery.admitted,
      ...(value.order.queuePosition !== undefined
        ? { queuePosition: value.order.queuePosition }
        : {}),
      ...(value.delivery.fallbackReasonCode
        ? { fallbackReasonCode: value.delivery.fallbackReasonCode }
        : {}),
      ...(value.attachments.length > 0 ? { attachmentRefs: value.attachments } : {}),
      ...(value.highspeed
        ? { highspeed: value.highspeed }
        : persistedHighspeed.success
          ? { highspeed: persistedHighspeed.data }
          : {}),
      ...(value.inputOrigin ? { inputOrigin: value.inputOrigin } : {}),
      ...(value.conversationQuotes ? { conversationQuotes: value.conversationQuotes } : {}),
      ...(value.botGroupSource ? { botGroupSource: value.botGroupSource } : {}),
      ...(value.provenance ? { provenance: value.provenance } : {}),
      ...(value.source ? { source: value.source } : {}),
    };
  }

  // 兼容之前只持久化 metadata seed 的 transcript；新写入一律走上面的完整事实。
  const value = message.info.metadata?.inputIntent;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const intent = value as Record<string, unknown>;
  if (
    typeof intent.sourceCommandId !== "string" ||
    typeof intent.queueItemId !== "string" ||
    typeof intent.clientId !== "string" ||
    (intent.kind !== "sendText" && intent.kind !== "sendGoalCommand") ||
    typeof intent.admissionSeq !== "number" ||
    typeof intent.admittedAt !== "number" ||
    (intent.requestedDelivery !== "auto" &&
      intent.requestedDelivery !== "startNow" &&
      intent.requestedDelivery !== "queue" &&
      intent.requestedDelivery !== "guide") ||
    (intent.admittedDelivery !== "startNow" &&
      intent.admittedDelivery !== "queue" &&
      intent.admittedDelivery !== "guide")
  ) {
    return undefined;
  }
  return {
    ...(value as unknown as TurnInputIntentMetadata),
    ...(persistedHighspeed.success ? { highspeed: persistedHighspeed.data } : {}),
  };
}

export function executionKindOfMessage(
  message: MessageWithParts,
): "agent" | "controlOnly" | undefined {
  const value = message.info.metadata?.executionKind;
  return value === "agent" || value === "controlOnly" ? value : undefined;
}

/**
 * 引擎附加文本的起点：热路径它在 TurnStarted 上，
 * 冷路径从用户消息 metadata 读回同一个字段。只认非负整数——别的形状按缺席处理（宁可多显示）。
 */
export function epilogueStartOfMessage(message: MessageWithParts): number | undefined {
  const value = message.info.metadata?.epilogueStart;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function contentBlocksToText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const chunks = value
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const text = (block as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    })
    .filter((text) => text.length > 0);
  return chunks.length > 0 ? chunks.join("\n\n") : undefined;
}

export function agentIdFromToolOutput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /(?:^|\r?\n)agentId:\s*([^\s(]+)/u.exec(value)?.[1];
}
