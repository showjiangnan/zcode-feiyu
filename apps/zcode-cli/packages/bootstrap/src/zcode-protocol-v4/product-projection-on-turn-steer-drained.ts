// Modified by ZCode Feiyu.
import type {
  SessionEvent,
  TurnSteerDrainedPayload,
  TurnInputIntentMetadata,
} from "@zcode/contracts";
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjection } from "./product-projection.js";

export function onTurnSteerDrained(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDrainedPayload;
  const runtimeTurnId = String(
    payload.targetTurnId ?? event.turnId ?? this["currentTurnId"] ?? "turn-unknown",
  );
  // drain 事实优先自带文本/messageId（drainedInputs），
  // 投影不再依赖内存 queue 状态取文本——旧实现查不到 queue item 就静默 continue，
  // 用户输入从 queue 消失后也不进 history。旧事件（无 drainedInputs）回退查表。
  const items =
    payload.drainedInputs ??
    payload.pendingInputIds.flatMap((pendingInputId, index) => {
      const queueItem = this["snapshot"].queue.items.find(
        (candidate) => candidate.queueItemId === pendingInputId,
      );
      if (!queueItem) return [];
      const intent: TurnInputIntentMetadata = {
        sourceCommandId: queueItem.sourceCommandId,
        queueItemId: queueItem.queueItemId,
        clientId: queueItem.clientId,
        kind: queueItem.kind,
        text: queueItem.text,
        ...(queueItem.modelSelection ? { modelSelection: queueItem.modelSelection } : {}),
        ...(queueItem.mode ? { mode: queueItem.mode } : {}),
        ...(queueItem.planEnabled !== undefined ? { planEnabled: queueItem.planEnabled } : {}),
        admissionSeq: queueItem.order.admissionSeq,
        admittedAt: queueItem.admittedAt,
        requestedDelivery: queueItem.delivery.requested,
        admittedDelivery: queueItem.delivery.admitted,
        queuePosition: queueItem.order.queuePosition,
        ...(queueItem.delivery.fallbackReasonCode
          ? { fallbackReasonCode: queueItem.delivery.fallbackReasonCode }
          : {}),
        attachmentRefs: queueItem.attachments,
      };
      return [
        {
          pendingInputId,
          messageId: payload.injectedMessageIds?.[index],
          text: queueItem.text,
          delivery: this["deliveryByPendingInputId"].get(pendingInputId),
          intent,
        },
      ];
    });
  const deltas: ConversationDelta[] = [];
  for (const item of items) {
    const delivery =
      item.delivery ?? this["deliveryByPendingInputId"].get(item.pendingInputId) ?? "queue";
    // queue 消费 = product turn 边界（每条一轮：收口上一段
    // header、开新 turnHeader、后续 assistant 归新轮）；guide steer 内联当前轮。
    if (delivery === "queue") {
      deltas.push(
        ...this["splitProductTurn"](
          event,
          runtimeTurnId,
          item.messageId ? String(item.messageId) : undefined,
        ),
      );
    }
    const messageId = item.messageId ? String(item.messageId) : null;
    const entityId = messageId ?? item.pendingInputId;
    const productTurnId = this["turnIdOf"](event);
    const rootSourceCommandId =
      item.intent?.provenance?.sourceCommandId ?? item.intent?.sourceCommandId;
    const row = {
      ...this["rowBase"](event, productTurnId, entityId),
      kind: "userInput" as const,
      text:
        item.intent?.conversationQuotes || item.intent?.botGroupSource
          ? (item.intent.text ?? item.text)
          : item.text,
      origin: item.intent?.interTaskSourceTaskId
        ? ("interTaskAuto" as const)
        : ("realUser" as const),
      ...(item.intent?.interTaskSourceTaskId
        ? { sourceTaskId: item.intent.interTaskSourceTaskId }
        : {}),
      ...(delivery === "guide" ? { guided: true as const } : {}),
      ...(item.intent?.sourceCommandId ? { sourceCommandId: item.intent.sourceCommandId } : {}),
      ...(rootSourceCommandId ? { rootSourceCommandId } : {}),
      ...(item.intent?.inputOrigin ? { inputOrigin: item.intent.inputOrigin } : {}),
      ...(item.intent?.conversationQuotes
        ? { conversationQuotes: item.intent.conversationQuotes }
        : {}),
      ...(item.intent?.botGroupSource ? { botGroupSource: item.intent.botGroupSource } : {}),
      ...(item.intent?.clientId ? { clientId: item.intent.clientId } : {}),
      ...(item.intent?.highspeed ? { highspeed: item.intent.highspeed } : {}),
      ...(item.intent?.attachmentRefs?.length ? { attachments: item.intent.attachmentRefs } : {}),
      ...(item.intent?.source ? { source: item.intent.source } : {}),
    };
    // queue/guide 消费后的 real-user row 与普通 TurnStarted 共用完整 canonical target；
    // 缺 messageId 的旧事件仍只可展示，不暴露无法执行的 edit action。
    this["registerCanonicalUserRowTarget"](
      row.rowId,
      entityId,
      messageId && item.intent?.kind !== "compact"
        ? {
            entityId,
            productTurnId,
            transcriptMessageId: messageId,
            coveredByStableCompact: false,
            intent: {
              kind: item.intent?.kind === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
              text: item.intent?.text ?? item.text,
              ...(item.intent?.causalContext ? { causalContext: item.intent.causalContext } : {}),
              ...(item.intent?.interTaskSourceTaskId
                ? { interTaskSourceTaskId: item.intent.interTaskSourceTaskId }
                : {}),
              ...(item.intent?.sourceCommandId
                ? { sourceCommandId: item.intent.sourceCommandId }
                : {}),
              ...(item.intent?.inputOrigin ? { inputOrigin: item.intent.inputOrigin } : {}),
              ...(item.intent?.conversationQuotes
                ? { conversationQuotes: item.intent.conversationQuotes }
                : {}),
              ...(item.intent?.botGroupSource
                ? { botGroupSource: item.intent.botGroupSource }
                : {}),
              ...(item.intent?.clientId ? { clientId: item.intent.clientId } : {}),
              ...(item.intent?.attachmentRefs ? { attachments: item.intent.attachmentRefs } : {}),
              ...(item.intent?.queueItemId ? { queueItemId: item.intent.queueItemId } : {}),
              ...(item.intent?.admissionSeq !== undefined
                ? { admissionSeq: item.intent.admissionSeq }
                : {}),
              ...(item.intent?.admittedAt !== undefined
                ? { admittedAt: item.intent.admittedAt }
                : {}),
              ...(item.intent?.requestedDelivery
                ? { requestedDelivery: item.intent.requestedDelivery }
                : {}),
              ...(item.intent?.admittedDelivery
                ? { admittedDelivery: item.intent.admittedDelivery }
                : {}),
              ...(item.intent?.fallbackReasonCode
                ? { fallbackReasonCode: item.intent.fallbackReasonCode }
                : {}),
              ...(item.intent?.modelSelection
                ? { modelSelection: item.intent.modelSelection }
                : {}),
              ...(item.intent?.mode ? { mode: item.intent.mode } : {}),
              ...(item.intent?.planEnabled !== undefined
                ? { planEnabled: item.intent.planEnabled }
                : {}),
              ...(item.intent?.provenance ? { provenance: item.intent.provenance } : {}),
            },
          }
        : undefined,
    );
    if (delivery === "guide") {
      deltas.push(...this["openGuidedWorkSegment"](event, row.entityId ?? item.pendingInputId));
    }
    deltas.push({ op: "row.appended", row });
    this["deliveryByPendingInputId"].delete(item.pendingInputId);
  }
  return [...deltas, ...this["removeQueueItems"](payload.pendingInputIds)];
}
