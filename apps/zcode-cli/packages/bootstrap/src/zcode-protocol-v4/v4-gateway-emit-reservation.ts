// Modified by ZCode Feiyu.
import type {
  RoutedTopicFrame,
  ConversationTopicFrame,
  SubscribeAck,
} from "@zcode/shared/zcode-protocol-v4";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import { parseConversationTopic, localTtftFactsSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  subscriptionRouteKey,
  encodeReservedTopicFrame,
} from "./v4-gateway-conversation-v4-gateway-options.js";
import type { V4SubscribeDispatchResult } from "./v4-gateway-conversation-v4-gateway-options.js";
import type { ConversationV4Gateway } from "./v4-gateway.js";

export function emitReservation<F extends RoutedTopicFrame>(
  this: ConversationV4Gateway,
  reservation: TopicFrameReservation<F>,
): boolean {
  // resync/subscribe recovery 已进入 request-scoped outbox 时，online
  // flush 若复用同一 inFlight 会让 physical wire 抢在 ACK response 前出站。
  if (this["controlReservations"].has(reservation)) return false;
  const sessionId = parseConversationTopic(reservation.frame.topic);
  const route = this["flushStates"].get(
    subscriptionRouteKey(
      reservation.frame.topic,
      reservation.frame.subscriptionId,
      sessionId
        ? (this["publishers"]
            .get(sessionId)
            ?.connectionIdForSubscription(reservation.frame.subscriptionId) ?? "")
        : "",
    ),
  );
  if (
    sessionId &&
    route?.deliveryProfile === "continuous" &&
    reservation.deliveryKind === "online" &&
    reservation.frame.payload.kind === "deltas" &&
    this["localTtft"].forSession(sessionId)
  ) {
    const rows = this["publishers"].get(sessionId)?.getSnapshot().rows.window ?? [];
    const turns = new Set<string>();
    for (const delta of reservation.frame.payload.deltas) {
      if (delta.op === "row.appended" || delta.op === "row.upserted") turns.add(delta.row.turnId);
      else if (delta.op === "row.delta") {
        const row = rows.find((item) => item.rowId === delta.rowId);
        if (row) turns.add(row.turnId);
      }
    }
    const related = rows
      .filter((row) => row.kind === "turnHeader" && turns.has(row.turnId))
      .flatMap((header) =>
        header.kind === "turnHeader" && header.sourceCommandId
          ? [this["localTtft"].forSession(sessionId, header.sourceCommandId)]
          : [],
      )
      .filter((facts) => facts !== undefined);
    const candidates = related.length ? related : [this["localTtft"].forSession(sessionId)];
    const observations: import("@zcode/shared").LocalTtftFacts[] = [];
    for (const facts of candidates) {
      if (!facts || observations.some((item) => item.observationId === facts.observationId))
        continue;
      const header = rows.find(
        (row) => row.kind === "turnHeader" && row.sourceCommandId === facts.commandId,
      );
      const observation = localTtftFactsSchema.safeParse({
        ...facts,
        ...(this["host"].cliVersion ? { cliVersion: this["host"].cliVersion } : {}),
        ...(header ? { productTurnId: header.turnId } : {}),
      });
      // 转正前后的内容可能被同批发送；按实际 row 所属原输入携带事实，不能取最新队列项。
      if (observation.success) observations.push(observation.data);
    }
    if (observations.length) {
      (reservation.frame as ConversationTopicFrame).ttft = observations[0];
      if (observations.length > 1)
        (reservation.frame as ConversationTopicFrame).ttftRelated = observations.slice(1, 17);
    }
  }
  const wires = encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>);
  for (const wire of wires) this["host"].emitWireFrame(wire);
  return reservation.commit();
}

export function subscribeDispatch<F extends RoutedTopicFrame>(
  this: ConversationV4Gateway,
  ack: SubscribeAck,
  reservation: TopicFrameReservation<F> | null,
  afterCommit?: () => void,
): V4SubscribeDispatchResult<F> {
  const initialWires = reservation
    ? encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>)
    : [];
  if (reservation) this["controlReservations"].add(reservation);
  let afterCommitRan = false;
  return {
    ack,
    initialFrame: reservation?.frame ?? null,
    initialWires,
    commit: () => {
      if (!reservation) return true;
      this["controlReservations"].delete(reservation);
      const committed = reservation.commit();
      if (committed && !afterCommitRan) {
        afterCommitRan = true;
        // control reservation 等 ACK/outbox admission 时，既有 flush timer
        // 可能已触发并因同一 inFlight 被抑制。commit 后必须主动重驱动 publisher，
        // 否则期间积累的 delta 会一直等到下一次 ingest/publish 才可见。
        afterCommit?.();
      }
      return committed;
    },
  };
}
