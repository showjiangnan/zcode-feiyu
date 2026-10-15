// Modified by ZCode Feiyu.
import { z } from "zod";
import { supportsTeamorouterFast } from "./teamorouter.js";
import type { ModelSpeed } from "./model-selection.js";
import {
  getSubscriptionSpeedOptions,
  type ChatGPTModelCapabilities,
} from "./chatgpt-subscription-catalog.js";

export const modelServiceTierSchema = z.enum(["default", "fast", "priority", "ultrafast"]);
export const modelSpeedObservationSchema = z
  .object({
    requestedServiceTier: modelServiceTierSchema,
    actualServiceTier: modelServiceTierSchema.optional(),
    downgraded: z.boolean().optional(),
  })
  .strict();
export type ModelSpeedObservation = z.infer<typeof modelSpeedObservationSchema>;

export type ModelSpeedCapabilities = Readonly<{ fast: boolean; ultrafast: boolean }>;
export function getTeamorouterSpeedCapabilities(
  input?: ModelSpeedCapabilities | null,
): ModelSpeedCapabilities {
  return input ?? { fast: true, ultrafast: false };
}

/** 能力只是下一轮允许选择的档位，不读取旧 fastMode 执行偏好。 */
export function getModelSpeedOptions(
  provider: Parameters<typeof supportsModelSpeed>[0],
  modelId: string,
  model?: {
    readonly speedCapabilities?: ModelSpeedCapabilities | null;
    readonly fastMode?: boolean | null;
  },
): readonly ModelSpeed[] {
  if (!supportsModelSpeed(provider, modelId)) return ["standard"];
  if (provider.access?.type === "chatgpt-subscription")
    return getSubscriptionSpeedOptions(provider.access.modelCapabilities?.[modelId]);
  if (!supportsTeamorouterFast(provider.api?.type, provider.api?.baseUrl, modelId))
    return ["standard", "fast", "ultrafast"];
  const capabilities = getTeamorouterSpeedCapabilities(model?.speedCapabilities);
  return [
    "standard",
    ...(capabilities.fast ? ["fast" as const] : []),
    ...(capabilities.ultrafast ? ["ultrafast" as const] : []),
  ];
}

/** 这是请求准入，不是账户速度 entitlement；模型成员关系由原 Registry 校验。 */
export function supportsModelSpeed(
  provider: {
    readonly api?: { readonly type?: string | null; readonly baseUrl?: string | null } | null;
    readonly access?: {
      readonly type: string;
      readonly entitled?: boolean | null;
      readonly modelCapabilities?: Readonly<Record<string, ChatGPTModelCapabilities>>;
    } | null;
  },
  modelId: string,
): boolean {
  // 读投影允许部分配置；缺失字段不能被当成完整 Provider，也不能使模型菜单崩溃。
  if (supportsTeamorouterFast(provider.api?.type, provider.api?.baseUrl, modelId)) return true;
  return (
    provider.access?.type === "chatgpt-subscription" &&
    provider.access.entitled === true &&
    provider.api?.type === "openai-responses" &&
    provider.api.baseUrl === "https://api.openai.com/v1" &&
    /^gpt-[a-z0-9][a-z0-9.-]*$/u.test(modelId) &&
    !/^gpt-image(?:-|$)/u.test(modelId)
  );
}
