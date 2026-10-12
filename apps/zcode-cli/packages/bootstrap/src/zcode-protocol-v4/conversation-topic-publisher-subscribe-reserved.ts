// Modified by ZCode Feiyu.
import type {
  ConversationSubscribeParams,
  ConversationSubscribeResult,
  Subscription,
} from "./conversation-topic-publisher-log-entry.js";
import { DELIVERY_PROFILES, coalesceConversationDeltas } from "@zcode/shared/zcode-protocol-v4";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTopicPublisher } from "./conversation-topic-publisher.js";

export function subscribeReserved(
  this: ConversationTopicPublisher,
  params: ConversationSubscribeParams,
): ConversationSubscribeResult {
  const previousId = this["subscriptionIdByConnection"].get(params.connectionId);
  const previousSubscription =
    previousId === undefined ? undefined : this["subscriptions"].get(previousId);
  if (previousId !== undefined) this["subscriptions"].delete(previousId);
  const profile = DELIVERY_PROFILES[params.deliveryProfile ?? "replayable"];
  const subscription: Subscription = {
    subscriptionId: `sub-${this["logEpoch"]}-${this["nextSubscriptionSerial"]++}`,
    connectionId: params.connectionId,
    profile,
    workflowRunDeltas: params.workflowRunDeltas === true,
    buffer: [],
    bufferBytes: 0,
    resyncRequired: false,
    sentSeq: 0,
    inFlight: null,
    nextLogicalFrameOrdinal: 1,
  };
  this["subscriptions"].set(subscription.subscriptionId, subscription);
  this["subscriptionIdByConnection"].set(params.connectionId, subscription.subscriptionId);
  const rollback = (): boolean => {
    // initial reservation commit 后 replacement 已 admission，禁止迟到 rollback。
    if (
      subscription.inFlight === null ||
      this["subscriptions"].get(subscription.subscriptionId) !== subscription ||
      this["subscriptionIdByConnection"].get(params.connectionId) !== subscription.subscriptionId
    ) {
      return false;
    }
    this["subscriptions"].delete(subscription.subscriptionId);
    if (previousId !== undefined && previousSubscription) {
      this["subscriptions"].set(previousId, previousSubscription);
      this["subscriptionIdByConnection"].set(params.connectionId, previousId);
    } else {
      this["subscriptionIdByConnection"].delete(params.connectionId);
    }
    return true;
  };
  const base = params.base;
  const resumable =
    base !== undefined &&
    base.logEpoch === this["logEpoch"] &&
    base.seq >= this["floorSeq"] &&
    base.seq <= this["currentSeq"];
  if (!resumable) {
    const reservation = this["reserveFrame"](
      subscription,
      {
        ...this["frameShell"](subscription),
        fromSeq: 0,
        toSeq: this["currentSeq"],
        payload: {
          kind: "snapshot",
          snapshot: this["getWireSnapshotForSubscription"](subscription),
        },
      },
      false,
      "initial",
    );
    return this["subscribeResult"](this["ackFor"](subscription, "snapshot"), reservation, rollback);
  }
  // resume：保留窗内 (base.seq, current] 重放，与在线续流同一条 filter→编码→coalesce 管线。
  const replay = coalesceConversationDeltas(
    this["encodeDeltasForSubscription"](
      this["log"].flatMap((entry) => (entry.seq > base.seq ? entry.deltas : [])),
      subscription,
    ),
  );
  if (base.seq === this["currentSeq"]) {
    subscription.sentSeq = base.seq;
    return this["subscribeResult"](this["ackFor"](subscription, "resume"), null, () => false);
  }
  subscription.sentSeq = base.seq;
  const reservation = this["reserveFrame"](
    subscription,
    {
      ...this["frameShell"](subscription),
      fromSeq: base.seq,
      toSeq: this["currentSeq"],
      payload: { kind: "deltas", deltas: replay },
    },
    false,
    "initial",
  );
  return this["subscribeResult"](this["ackFor"](subscription, "resume"), reservation, rollback);
}

export function unsubscribe(
  this: ConversationTopicPublisher,
  subscriptionId: string,
  connectionId?: string,
): void {
  const subscription = this["subscriptions"].get(subscriptionId);
  if (!subscription) return;
  if (connectionId !== undefined && subscription.connectionId !== connectionId) {
    return;
  }
  this["subscriptions"].delete(subscriptionId);
  if (this["subscriptionIdByConnection"].get(subscription.connectionId) === subscriptionId) {
    this["subscriptionIdByConnection"].delete(subscription.connectionId);
  }
}

export function hasSubscription(
  this: ConversationTopicPublisher,
  subscriptionId: string,
  connectionId?: string,
): boolean {
  const subscription = this["subscriptions"].get(subscriptionId);
  return Boolean(
    subscription && (connectionId === undefined || subscription.connectionId === connectionId),
  );
}

export function hasSubscribers(this: ConversationTopicPublisher): boolean {
  return this["subscriptions"].size > 0;
}

export function connectionIdForSubscription(
  this: ConversationTopicPublisher,
  subscriptionId: string,
): string | null {
  return this["subscriptions"].get(subscriptionId)?.connectionId ?? null;
}

export function reserveFlush(
  this: ConversationTopicPublisher,
  subscriptionId: string,
): TopicFrameReservation<ConversationTopicFrame> | null {
  const subscription = this["subscriptions"].get(subscriptionId);
  if (!subscription) return null;
  if (subscription.inFlight) return subscription.inFlight;
  if (subscription.resyncRequired) {
    subscription.buffer = [];
    subscription.bufferBytes = 0;
    return this["reserveFrame"](
      subscription,
      {
        ...this["frameShell"](subscription),
        fromSeq: 0,
        toSeq: this["currentSeq"],
        payload: {
          kind: "snapshot",
          snapshot: this["getWireSnapshotForSubscription"](subscription),
        },
      },
      true,
      "online",
    );
  }
  if (subscription.buffer.length === 0 && subscription.sentSeq === this["currentSeq"]) {
    return null;
  }
  const deltas = subscription.buffer;
  const frame: ConversationTopicFrame = {
    ...this["frameShell"](subscription),
    fromSeq: subscription.sentSeq,
    toSeq: this["currentSeq"],
    payload: { kind: "deltas", deltas },
  };
  subscription.buffer = [];
  subscription.bufferBytes = 0;
  return this["reserveFrame"](subscription, frame, false, "online");
}

export function flush(
  this: ConversationTopicPublisher,
  subscriptionId: string,
): ConversationTopicFrame | null {
  const reservation = this.reserveFlush(subscriptionId);
  if (!reservation || !reservation.commit()) return null;
  return reservation.frame;
}
