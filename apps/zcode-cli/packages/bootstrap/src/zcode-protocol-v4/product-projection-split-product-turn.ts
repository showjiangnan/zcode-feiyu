// Modified by ZCode Feiyu.
import type {
  SessionEvent,
  TurnSteerDiscardedPayload,
  SessionInputPromotedPayload,
} from "@zcode/contracts";
import type { ConversationDelta, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { buildTurnHeaderRow } from "./projection-rows.js";
import { computeAvailability, computeInputRouting } from "./projection-state.js";
import type { ProductProjection } from "./product-projection.js";

export function splitProductTurn(
  this: ProductProjection,
  event: SessionEvent,
  runtimeTurnId: string,
  promotedUserMessageId?: string,
): ConversationDelta[] {
  const deltas: ConversationDelta[] = [];
  const previousProductTurnId =
    this["productTurnIdByRuntimeTurnId"].get(runtimeTurnId) ?? runtimeTurnId;
  const headerRowId = this["turnHeaderRowIdByTurnId"].get(previousProductTurnId);
  const headerRow = headerRowId !== undefined ? this["findRow"](headerRowId) : undefined;
  if (headerRow?.kind === "turnHeader") {
    const endedAt = this["ms"](event);
    deltas.push({
      op: "row.upserted",
      row: {
        ...headerRow,
        state: "completedSuccess",
        endedAt,
        activeMs: Math.max(
          0,
          endedAt - (this["currentProductTurnStartedAtMs"] ?? headerRow.startedAt),
        ),
        ...(headerRow.workSegments
          ? {
              workSegments: this["completeWorkSegments"](headerRow.workSegments, endedAt),
            }
          : {}),
      },
    });
  }
  const ordinal = (this["productTurnSplitOrdinalByRuntimeTurnId"].get(runtimeTurnId) ?? 0) + 1;
  this["productTurnSplitOrdinalByRuntimeTurnId"].set(runtimeTurnId, ordinal);
  // 旧实现用 runtimeTurnId + 本次进程内 ordinal 造 productTurnId；
  // cold hydration 会改用 hydrate-turn-N，同一条 queue 输入恢复前后无法保持身份。
  // promotion 已产生持久 user messageId，新 product turn 必须直接使用该权威身份；
  // 只有 legacy drain 缺 messageId 时才保留 ordinal fallback。
  const productTurnId = promotedUserMessageId ?? `${runtimeTurnId}~q${ordinal}`;
  this["productTurnIdByRuntimeTurnId"].set(runtimeTurnId, productTurnId);
  this["runtimeTurnIdByProductTurnId"].set(productTurnId, runtimeTurnId);
  this["currentProductTurnStartedAtMs"] = this["ms"](event);
  const header = buildTurnHeaderRow(this["rowBase"](event, productTurnId, productTurnId), {
    turnNumber: 0,
    input: "",
  });
  this["turnHeaderRowIdByTurnId"].set(productTurnId, header.rowId);
  deltas.push({ op: "row.appended", row: header });
  return deltas;
}

export function activeMsForCompletion(
  this: ProductProjection,
  event: SessionEvent,
  runtimeDuration?: number,
): number | undefined {
  const runtimeTurnId = String(event.turnId ?? this["currentTurnId"] ?? "turn-unknown");
  // 稳定 user messageId 映射并不代表发生过 queue drain 切段；只有 split ordinal
  // 存在时才按边界时间计算最后一段工时。否则 cold 合成事件的展示时间戳跨度很小，
  // 会错误覆盖 transcript 已计算好的整轮 duration。
  if (!this["productTurnSplitOrdinalByRuntimeTurnId"].has(runtimeTurnId)) return runtimeDuration;
  if (this["currentProductTurnStartedAtMs"] === null) return runtimeDuration;
  return Math.max(0, this["ms"](event) - this["currentProductTurnStartedAtMs"]);
}

export function onTurnSteerDiscarded(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDiscardedPayload;
  return this["removeQueueItems"](payload.pendingInputIds);
}

export function onSessionInputPromoted(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as SessionInputPromotedPayload;
  // sendQueuedNow 启动成功后，显式 TurnSteerDiscarded(promoted)
  // 可能在进程/链路边界丢失，使 UI 永久留下 promoting 幽灵项。
  // SessionInputPromoted 只在 user message + session_input 同事务提交后产生，
  // 因此它才是可以安全移除 queue 投影的 durable commit signal。
  return this["removeQueueItems"]([payload.pendingInputId]);
}

export function onTurnSteerReordered(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    orderedPendingInputIds?: string[];
  };
  const order = payload.orderedPendingInputIds ?? [];
  const byId = new Map(this["snapshot"].queue.items.map((item) => [item.queueItemId, item]));
  const ordered = order
    .map((id) => byId.get(id))
    .filter(
      (item): item is ProductProjection["snapshot"]["queue"]["items"][number] => item !== undefined,
    );
  // 未在 order 里出现的项（防丢）追加保持原相对序。
  const orderedIds = new Set(order);
  const rest = this["snapshot"].queue.items.filter((item) => !orderedIds.has(item.queueItemId));
  const reordered = [...ordered, ...rest];
  const items = reordered.map((item, index) =>
    item.order.queuePosition === index
      ? item
      : { ...item, order: { ...item.order, queuePosition: index } },
  );
  // 顺序无变化则不产 delta（幂等）。
  if (
    items.length === this["snapshot"].queue.items.length &&
    items.every((item, index) => item === this["snapshot"].queue.items[index])
  ) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: this["queuePatch"]({ ...this["snapshot"].queue, items }),
    },
  ];
}

export function onQueueAutoDrainChanged(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    autoDrain?: boolean;
  };
  const autoDrain = payload.autoDrain ?? true;
  if (
    this["snapshot"].queue.autoDrain === autoDrain &&
    (autoDrain || this["snapshot"].queue.pauseReason === "manual")
  ) {
    return [];
  }
  const queue = { ...this["snapshot"].queue, autoDrain };
  if (autoDrain) {
    delete queue.pauseReason;
  } else {
    queue.pauseReason = "manual";
  }
  return [
    {
      op: "state.updated",
      patch: this["queuePatch"](queue),
    },
  ];
}

export function onFollowupModeChanged(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    mode?: "queue" | "guide";
  };
  const mode: "queue" | "guide" = payload.mode === "guide" ? "guide" : "queue";
  if (this["snapshot"].config.followupMode === mode) return [];
  const nextConfig: ConversationSnapshot["config"] = {
    ...this["snapshot"].config,
    followupMode: mode,
  };
  const context = this["deriveContext"]({});
  return [
    {
      op: "state.updated",
      patch: {
        config: nextConfig,
        availability: computeAvailability(context),
        inputRouting: computeInputRouting(context, mode),
      },
    },
  ];
}
