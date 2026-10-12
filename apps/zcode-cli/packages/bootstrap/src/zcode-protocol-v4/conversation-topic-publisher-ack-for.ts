// Modified by ZCode Feiyu.
import type { Subscription } from "./conversation-topic-publisher-log-entry.js";
import type { SubscribeAck, ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTopicPublisher } from "./conversation-topic-publisher.js";

export function ackFor(
  this: ConversationTopicPublisher,
  subscription: Subscription,
  mode: SubscribeAck["mode"],
): SubscribeAck {
  return {
    subscriptionId: subscription.subscriptionId,
    mode,
    logEpoch: this["logEpoch"],
  };
}

export function frameShell(
  this: ConversationTopicPublisher,
  subscription: Subscription,
): Pick<ConversationTopicFrame, "topic" | "subscriptionId" | "sentAt"> {
  return {
    topic: this.topic,
    subscriptionId: subscription.subscriptionId,
    sentAt: this["now"](),
  };
}
