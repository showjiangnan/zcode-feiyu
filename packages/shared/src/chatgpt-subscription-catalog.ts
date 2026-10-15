// Modified by ZCode Feiyu.
import { z } from "zod";

export type SubscriptionCatalogJson =
  | null
  | boolean
  | number
  | string
  | SubscriptionCatalogJson[]
  | { [key: string]: SubscriptionCatalogJson };

/** 模型元数据是数据，不是凭据或可执行配置；深度、节点数和总字符数都有限制。 */
function boundedCatalogJson(value: unknown): value is SubscriptionCatalogJson {
  let nodes = 0,
    characters = 0;
  const visit = (entry: unknown, depth: number): boolean => {
    if (++nodes > 4096 || depth > 8) return false;
    if (entry === null || typeof entry === "boolean") return true;
    if (typeof entry === "number") return Number.isFinite(entry);
    if (typeof entry === "string") {
      characters += entry.length;
      return entry.length <= 262144 && characters <= 524288;
    }
    if (Array.isArray(entry)) return entry.length <= 128 && entry.every((v) => visit(v, depth + 1));
    if (!entry || typeof entry !== "object" || Object.getPrototypeOf(entry) !== Object.prototype)
      return false;
    const entries = Object.entries(entry);
    return (
      entries.length <= 128 &&
      entries.every(
        ([key, v]) =>
          key.length <= 128 &&
          !/^(?:access.?token|refresh.?token|id.?token|api.?key|authorization|credentials|headers)$/iu.test(
            key,
          ) &&
          visit(v, depth + 1),
      )
    );
  };
  return visit(value, 0);
}

export const subscriptionCatalogJsonSchema = z.custom<SubscriptionCatalogJson>(boundedCatalogJson);
const label = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim().length > 0);
const description = z.string().max(4096);
const labels = z.array(label).max(128);
const metadata = z.record(label, subscriptionCatalogJsonSchema).refine(boundedCatalogJson);

export const chatGPTModelCapabilitiesSchema = z
  .object({
    serviceTiers: z
      .array(
        z
          .object({ id: label, name: label.optional(), description: description.optional() })
          .strict(),
      )
      .max(32)
      .optional(),
    additionalSpeedTiers: labels.optional(),
    defaultReasoningLevel: label.optional(),
    supportedReasoningLevels: z
      .array(z.object({ effort: label, description: description.optional() }).strict())
      .max(32)
      .optional(),
    defaultReasoningSummary: label.optional(),
    contextWindow: z.number().int().positive().max(100000000).optional(),
    maxContextWindow: z.number().int().positive().max(100000000).optional(),
    effectiveContextWindowPercent: z.number().int().min(1).max(100).optional(),
    inputModalities: labels.optional(),
    supportsImageDetailOriginal: z.boolean().optional(),
    supportsSearchTool: z.boolean().optional(),
    webSearchToolType: label.optional(),
    applyPatchToolType: label.optional(),
    experimentalSupportedTools: labels.optional(),
    shellType: label.optional(),
    toolMode: label.optional(),
    useResponsesLite: z.boolean().optional(),
    nodeReplDisabled: z.boolean().optional(),
    nodeReplAutoReviewRequired: z.boolean().optional(),
    multiAgentVersion: label.optional(),
    multiAgentReasoningEffort: label.optional(),
    supportVerbosity: z.boolean().optional(),
    defaultVerbosity: label.optional(),
    supportsReasoningEffortUpdates: z.boolean().optional(),
    supportsExperimentalContext: z.boolean().optional(),
    supportedInApi: z.boolean().optional(),
    availableAccessPrograms: metadata.optional(),
    truncationPolicy: z
      .object({ mode: label, limit: z.number().int().nonnegative() })
      .strict()
      .optional(),
    description: description.optional(),
    priority: z.number().int().optional(),
    availabilityNux: subscriptionCatalogJsonSchema.optional(),
    upgrade: subscriptionCatalogJsonSchema.optional(),
  })
  .strict();

export type ChatGPTModelCapabilities = z.infer<typeof chatGPTModelCapabilitiesSchema>;

/** Fast 的展示同义词不能覆盖服务端具体 wire id；旧目录沿 priority 合同。 */
export function getSubscriptionFastServiceTier(
  capabilities?: ChatGPTModelCapabilities,
): "priority" | "fast" {
  const tiers = capabilities?.serviceTiers?.map((tier) => tier.id);
  return tiers?.includes("fast") && !tiers.includes("priority") ? "fast" : "priority";
}

export function getSubscriptionEffectiveContextWindow(model: {
  contextWindow?: number;
  capabilities?: ChatGPTModelCapabilities;
}): number {
  const window = model.capabilities?.contextWindow ?? model.contextWindow ?? 131072;
  return Math.max(
    1,
    Math.floor((window * (model.capabilities?.effectiveContextWindowPercent ?? 100)) / 100),
  );
}

export const chatGPTSubscriptionModelSchema = z
  .object({
    slug: label,
    displayName: label,
    inputModalities: labels.optional(),
    contextWindow: z.number().int().positive().optional(),
    contextWindowSource: z
      .enum(["official-model-reference", "local-planning-fallback", "subscription-catalog"])
      .optional(),
    reasoningLevels: labels.optional(),
    capabilities: chatGPTModelCapabilitiesSchema.optional(),
  })
  .strict();

/** 只依赖本模型公布的 wire 档位；显式空列表优先于旧展示提示。 */
export function getSubscriptionSpeedOptions(
  capabilities?: ChatGPTModelCapabilities,
): readonly ("standard" | "fast" | "ultrafast")[] {
  const tiers =
    capabilities?.serviceTiers?.map((tier) => tier.id) ?? capabilities?.additionalSpeedTiers;
  if (tiers === undefined) return ["standard", "fast", "ultrafast"];
  return [
    "standard",
    ...(tiers.some((tier) => tier === "fast" || tier === "priority") ? ["fast" as const] : []),
    ...(tiers.includes("ultrafast") ? ["ultrafast" as const] : []),
  ];
}
