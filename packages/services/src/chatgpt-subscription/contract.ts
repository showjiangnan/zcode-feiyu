// Modified by ZCode Feiyu.
import { createServiceDescriptor } from "../descriptors.js";
import type { ChatGPTSubscriptionCommand, ChatGPTSubscriptionView } from "@zcode/shared";
export type {
  ChatGPTConnectionStatus,
  ChatGPTSubscriptionModel,
  ChatGPTSubscriptionConnection,
  ChatGPTSubscriptionCommand,
  ChatGPTSubscriptionView,
} from "@zcode/shared";

/** 脱敏展示合同；没有 token getter 或通用 fetch 方法。 */
export interface IChatGPTSubscriptionService {
  execute(command: ChatGPTSubscriptionCommand): Promise<ChatGPTSubscriptionView>;
}
export const IChatGPTSubscriptionService =
  createServiceDescriptor<IChatGPTSubscriptionService>("chatgpt-subscription");
