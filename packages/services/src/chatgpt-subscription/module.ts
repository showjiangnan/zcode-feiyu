// Modified by ZCode Feiyu.
export const chatgptSubscriptionModule = {
  id: "chatgpt-subscription",
  requires: ["services", "shared", "provider", "provider-node"],
  provides: ["chatgpt-subscription"],
  publicEntrypoints: ["contract.ts", "node.ts"],
} as const;
