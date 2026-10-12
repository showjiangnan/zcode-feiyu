// Modified by ZCode Feiyu.
import type {
  ConversationResyncRequest,
  ConversationSubscribeResult,
  Subscription,
  ConversationSubscriberBufferLimits,
} from "./conversation-topic-publisher-log-entry.js";
import { coalesceConversationDeltas } from "@zcode/shared/zcode-protocol-v4";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import type {
  ConversationTopicFrame,
  TopicFrameDeliveryKind,
  SubscribeAck,
} from "@zcode/shared/zcode-protocol-v4";
import { appendConversationSubscriberBuffer } from "./conversation-topic-publisher-log-entry.js";
import type { ConversationTopicPublisher } from "./conversation-topic-publisher.js";

export function resyncReserved(
  this: ConversationTopicPublisher,
  subscriptionId: string,
  request: ConversationResyncRequest,
): ConversationSubscribeResult | null {
  const subscription = this["subscriptions"].get(subscriptionId);
  if (!subscription) return null;
  const previous = {
    buffer: subscription.buffer,
    bufferBytes: subscription.bufferBytes,
    resyncRequired: subscription.resyncRequired,
    sentSeq: subscription.sentSeq,
    inFlight: subscription.inFlight,
  };
  // 旧 resync 会先 commit 当前 reservation，再基于服务端 sentSeq 发 snapshot，
  // 这会把客户端未收到的帧误记为已送达。same-sub recovery 必须直接 supersede。
  subscription.inFlight = null;
  subscription.buffer = [];
  subscription.bufferBytes = 0;
  subscription.resyncRequired = false;
  const base = request.base;
  const resumable =
    !request.forceSnapshot &&
    base !== null &&
    base.logEpoch === this["logEpoch"] &&
    base.seq >= this["floorSeq"] &&
    base.seq <= this["currentSeq"];
  if (!resumable) {
    subscription.sentSeq = 0;
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
      "recovery",
    );
    return this["subscribeResult"](
      this["ackFor"](subscription, "snapshot"),
      reservation,
      this["resyncRollback"](subscription, reservation, previous),
    );
  }
  subscription.sentSeq = base.seq;
  const replay = coalesceConversationDeltas(
    this["encodeDeltasForSubscription"](
      this["log"].flatMap((entry) => (entry.seq > base.seq ? entry.deltas : [])),
      subscription,
    ),
  );
  const reservation = this["reserveFrame"](
    subscription,
    {
      ...this["frameShell"](subscription),
      fromSeq: base.seq,
      toSeq: this["currentSeq"],
      payload: { kind: "deltas", deltas: replay },
    },
    false,
    "recovery",
  );
  return this["subscribeResult"](
    this["ackFor"](subscription, "resume"),
    reservation,
    this["resyncRollback"](subscription, reservation, previous),
  );
}

export function resyncRollback(
  this: ConversationTopicPublisher,
  subscription: Subscription,
  reservation: TopicFrameReservation<ConversationTopicFrame>,
  previous: Pick<
    Subscription,
    "buffer" | "bufferBytes" | "resyncRequired" | "sentSeq" | "inFlight"
  >,
): () => boolean {
  let rolledBack = false;
  return (): boolean => {
    if (rolledBack) return true;
    if (
      this["subscriptions"].get(subscription.subscriptionId) !== subscription ||
      subscription.inFlight !== reservation
    ) {
      return false;
    }
    const recoveryBuffer = subscription.buffer;
    const recoveryResyncRequired = subscription.resyncRequired;
    const merged = appendConversationSubscriberBuffer(
      previous.buffer,
      recoveryBuffer,
      this["subscriberBufferLimits"](),
    );
    if (merged.kind === "overflow" || previous.resyncRequired || recoveryResyncRequired) {
      subscription.buffer = [];
      subscription.bufferBytes = 0;
      subscription.resyncRequired = true;
    } else {
      subscription.buffer = merged.deltas;
      subscription.bufferBytes = merged.encodedBytes;
      subscription.resyncRequired = false;
    }
    subscription.sentSeq = previous.sentSeq;
    subscription.inFlight = previous.inFlight;
    rolledBack = true;
    return true;
  };
}

export function subscriberBufferLimits(
  this: ConversationTopicPublisher,
): ConversationSubscriberBufferLimits {
  return {
    maxOps: this["subscriberBufferMaxOps"],
    maxBytes: this["subscriberBufferMaxBytes"],
    snapshotBytesUpperBound: this["wireSnapshotBytesUpperBound"],
  };
}

export function resync(
  this: ConversationTopicPublisher,
  subscriptionId: string,
): ConversationTopicFrame | null {
  const reservation = this.resyncReserved(subscriptionId, {
    base: null,
    forceSnapshot: true,
  })?.reservation;
  if (!reservation || !reservation.commit()) return null;
  return reservation.frame;
}

export function reserveFrame(
  this: ConversationTopicPublisher,
  subscription: Subscription,
  frame: ConversationTopicFrame,
  snapshotRecovery: boolean,
  deliveryKind: TopicFrameDeliveryKind,
): TopicFrameReservation<ConversationTopicFrame> {
  let committed = false;
  const reservation: TopicFrameReservation<ConversationTopicFrame> = {
    deliveryKind,
    logicalFrameId: `${subscription.subscriptionId}-lf-${this["nextLogicalFrameSerial"]++}`,
    logicalFrameOrdinal: subscription.nextLogicalFrameOrdinal++,
    frame,
    commit: () => {
      if (committed) return true;
      if (
        this["subscriptions"].get(subscription.subscriptionId) !== subscription ||
        subscription.inFlight !== reservation
      ) {
        return false;
      }
      subscription.sentSeq = frame.toSeq;
      subscription.inFlight = null;
      if (snapshotRecovery) {
        // snapshot 在途时 resyncRequired 会停止收 delta。
        // 若权威水位又推进，下一 reservation 必须再发最新 snapshot。
        subscription.resyncRequired = this["currentSeq"] > frame.toSeq;
      }
      committed = true;
      return true;
    },
  };
  subscription.inFlight = reservation;
  return reservation;
}

export function subscribeResult(
  this: ConversationTopicPublisher,
  ack: SubscribeAck,
  reservation: TopicFrameReservation<ConversationTopicFrame> | null,
  rollback: () => boolean,
): ConversationSubscribeResult {
  return {
    ack,
    reservation,
    rollback,
    // 兼容旧 publisher 单测：读 frame 即表示本地 transport 已接受。
    // 生产 gateway 只读 reservation，不会触发该 getter。
    get frame() {
      reservation?.commit();
      return reservation?.frame ?? null;
    },
  };
}
