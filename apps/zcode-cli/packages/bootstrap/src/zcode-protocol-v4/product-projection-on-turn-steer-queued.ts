// Modified by ZCode Feiyu.
import type {
  SessionEvent,
  TurnSteerQueuedPayload,
  TurnSteerDispatchChangedPayload,
  TurnSteerDeliveryChangedPayload,
} from "@zcode/contracts";
import type { ConversationDelta, QueueItem } from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjection } from "./product-projection.js";

export function onTurnSteerQueued(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerQueuedPayload;
  const queueItemId = payload.intent?.queueItemId ?? payload.pendingInputId;
  const existingIndex = this["snapshot"].queue.items.findIndex(
    (item) => item.queueItemId === queueItemId,
  );
  const existing = existingIndex >= 0 ? this["snapshot"].queue.items[existingIndex] : undefined;
  // queued 事件的 admittedDelivery 只能是 queue/guide。若读到早期或损坏事件里的
  // startNow，必须以实际 queue delivery 为准，不能让投影声称输入已立即启动。
  const admittedDelivery: "queue" | "guide" =
    payload.intent?.admittedDelivery === "queue" || payload.intent?.admittedDelivery === "guide"
      ? payload.intent.admittedDelivery
      : (payload.delivery ??
        (existing?.delivery.admitted === "queue" || existing?.delivery.admitted === "guide"
          ? existing.delivery.admitted
          : this["snapshot"].config.followupMode === "guide"
            ? "guide"
            : "queue"));
  const requestedDelivery =
    payload.intent?.requestedDelivery ?? existing?.delivery.requested ?? admittedDelivery;
  const fallbackReasonCode =
    payload.intent?.fallbackReasonCode ?? existing?.delivery.fallbackReasonCode;
  // Bug 根因：队列投影曾漏掉 intent.highspeed，自动和手动提升都因此把有效卡误判为不存在。
  const highspeed = payload.intent?.highspeed ?? existing?.highspeed;
  const nextItem: QueueItem = {
    queueItemId,
    kind:
      payload.intent?.kind === "compact" || payload.commandKind === "compact"
        ? ("compact" as const)
        : payload.intent?.kind === "sendGoalCommand" || payload.commandKind === "sendGoalCommand"
          ? ("sendGoalCommand" as const)
          : (existing?.kind ?? ("sendText" as const)),
    text: payload.input,
    sourceCommandId:
      payload.intent?.sourceCommandId ??
      existing?.sourceCommandId ??
      payload.inputId ??
      payload.pendingInputId,
    interTaskSourceTaskId: payload.intent?.interTaskSourceTaskId ?? existing?.interTaskSourceTaskId,
    causalContext: payload.intent?.causalContext ?? existing?.causalContext,
    clientId: payload.intent?.clientId ?? existing?.clientId ?? "cli",
    attachments: payload.intent?.attachmentRefs ?? existing?.attachments ?? [],
    ...((payload.intent?.source ?? existing?.source)
      ? { source: payload.intent?.source ?? existing?.source }
      : {}),
    // QueueItem 同时是提升执行的输入，不只是 UI 展示；漏字段会让新 Turn 沿用旧权限／模型。
    // 旧的正文编辑事件可能没有 intent，只能保留同项原事实，不能读取当前 Session 补值。
    modelSelection: payload.intent?.modelSelection ?? existing?.modelSelection,
    mode: payload.intent?.mode ?? existing?.mode,
    planEnabled: payload.intent?.planEnabled ?? existing?.planEnabled,
    sharedContextRefs: payload.intent?.sharedContextRefs ?? existing?.sharedContextRefs,
    provenance: payload.intent?.provenance ?? existing?.provenance,
    // 排队事件和原地编辑都必须保留可信接入来源，不能在 UI 投影时丢掉发送者。
    ...((payload.intent?.inputOrigin ?? existing?.inputOrigin)
      ? { inputOrigin: payload.intent?.inputOrigin ?? existing?.inputOrigin }
      : {}),
    ...((payload.intent?.conversationQuotes ?? existing?.conversationQuotes)
      ? { conversationQuotes: payload.intent?.conversationQuotes ?? existing?.conversationQuotes }
      : {}),
    ...((payload.intent?.botGroupSource ?? existing?.botGroupSource)
      ? { botGroupSource: payload.intent?.botGroupSource ?? existing?.botGroupSource }
      : {}),
    delivery: {
      requested: requestedDelivery,
      admitted: admittedDelivery,
      ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
    },
    order: {
      admissionSeq:
        payload.intent?.admissionSeq ?? existing?.order.admissionSeq ?? event.sequenceNumber,
      queuePosition:
        payload.intent?.queuePosition ??
        existing?.order.queuePosition ??
        Math.max(0, (payload.queueLength ?? 1) - 1),
    },
    steer:
      !payload.intent && !payload.delivery && existing
        ? existing.steer
        : fallbackReasonCode
          ? { state: "fellBack", reasonCode: fallbackReasonCode }
          : admittedDelivery === "guide"
            ? { state: "steering" }
            : { state: "notRequested" },
    dispatch: { state: "queued" },
    ...(highspeed ? { highspeed } : {}),
    ...(payload.toolDisallowlist ? { toolDisallowlist: [...payload.toolDisallowlist] } : {}),
    admittedAt: payload.intent?.admittedAt ?? existing?.admittedAt ?? this["ms"](event),
  };
  // 投递语义侧表：payload 未带（旧 runtime 事件）时按当前 followupMode 兜底。
  this["deliveryByPendingInputId"].set(payload.pendingInputId, admittedDelivery);
  // 同 id 重入 = editQueueItem 原地更新（保位）；新 id = 追加。旧逻辑 filter+append
  // 会把编辑项移到队尾，破坏 queueContentIndependence 的位置语义。
  const items =
    existingIndex >= 0
      ? this["snapshot"].queue.items.map((item, index) =>
          index === existingIndex ? nextItem : item,
        )
      : [...this["snapshot"].queue.items, nextItem];
  return [
    {
      op: "state.updated",
      patch: this["queuePatch"]({ ...this["snapshot"].queue, items }),
    },
  ];
}

export function onTurnSteerDispatchChanged(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDispatchChangedPayload;
  if (
    !this["snapshot"].queue.items.some(
      (candidate) => candidate.queueItemId === payload.pendingInputId,
    )
  ) {
    return [];
  }
  const dispatch =
    payload.state === "queued"
      ? ({ state: "queued" } as const)
      : ({
          state: payload.state,
          reservationId: payload.reservationId,
        } as const);
  return [
    {
      op: "state.updated",
      patch: this["queuePatch"]({
        ...this["snapshot"].queue,
        items: this["snapshot"].queue.items.map((candidate) =>
          candidate.queueItemId === payload.pendingInputId ? { ...candidate, dispatch } : candidate,
        ),
      }),
    },
  ];
}

export function onTurnSteerDeliveryChanged(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDeliveryChangedPayload;
  const queueItemId = payload.intent?.queueItemId ?? payload.pendingInputId;
  if (!this["snapshot"].queue.items.some((item) => item.queueItemId === queueItemId)) {
    return [];
  }
  this["deliveryByPendingInputId"].set(payload.pendingInputId, payload.admittedDelivery);
  return [
    {
      op: "state.updated",
      patch: this["queuePatch"]({
        ...this["snapshot"].queue,
        items: this["snapshot"].queue.items.map((item) =>
          item.queueItemId === queueItemId
            ? {
                ...item,
                delivery: {
                  requested: payload.requestedDelivery,
                  admitted: payload.admittedDelivery,
                  fallbackReasonCode: payload.fallbackReasonCode,
                },
                steer: {
                  state: "fellBack",
                  reasonCode: payload.fallbackReasonCode,
                },
              }
            : item,
        ),
      }),
    },
  ];
}
