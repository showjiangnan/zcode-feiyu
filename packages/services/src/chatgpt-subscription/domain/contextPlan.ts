// Modified by ZCode Feiyu.
/** 2026-10-12核对官方模型规格；只用于本地压缩规划，不代表订阅账户权限。 */
const verifiedModelSlugs = new Set([
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);
export function resolveSubscriptionContextPlan(slug: string) {
  return verifiedModelSlugs.has(slug)
    ? { contextWindow: 1050000, contextWindowSource: "official-model-reference" as const }
    : { contextWindow: 131072, contextWindowSource: "local-planning-fallback" as const };
}
