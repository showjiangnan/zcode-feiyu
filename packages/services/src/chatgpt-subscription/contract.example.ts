// Modified by ZCode Feiyu.
import type { ChatGPTSubscriptionCommand } from "./contract.js";
import type { ChatGPTSubscriptionModel } from "@zcode/shared";
export const exampleChatGPTSignIn: ChatGPTSubscriptionCommand = {
  type: "sign-in",
  mode: "sign-in",
};
export const exampleSubscriptionModel: ChatGPTSubscriptionModel = {
  slug: "gpt-6.1-sol",
  displayName: "GPT-6.1 Sol",
  capabilities: {
    serviceTiers: [{ id: "priority", name: "Fast" }],
    supportedReasoningLevels: [{ effort: "low" }, { effort: "high" }],
    defaultReasoningLevel: "low",
  },
};
