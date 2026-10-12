// Modified by ZCode Feiyu.
import { atomicWritePrivateTextFile } from "@zcode/shared/node";
import type { SubscriptionStorePort } from "../app/ports.js";
import { hasSubscriptionPermission } from "../domain/records.js";
import { resolveSubscriptionContextPlan } from "../domain/contextPlan.js";

/** 只有脱敏事实进入配置投影；默认连接变化不改写会话已保存的供应商身份。 */
export function createSubscriptionProjection(store: SubscriptionStorePort, file: string) {
  let queue = Promise.resolve();
  let previous: string | undefined;
  return () => {
    const operation = queue
      .catch(() => undefined)
      .then(async () => {
        const state = await store.read();
        const providers = state.profiles.map((profile) => ({
          providerId: `chatgpt-subscription:${profile.profileId}`,
          providerName: `ChatGPT · ${profile.label}`,
          // 隐藏退休连接仍供已准入任务构造模型；新请求的权限只由私有broker租约判定。
          enabled: profile.status === "connected",
          config: {
            group: "standard-personal",
            visibility: state.activeProfileId === profile.profileId ? "visible" : "hidden",
            access: {
              type: "chatgpt-subscription",
              profileId: profile.profileId,
              generation: profile.generation,
              label: profile.label,
              entitled: profile.status === "connected" && hasSubscriptionPermission(profile.tokens),
              modelDisplayNames: Object.fromEntries(
                profile.models.map((m) => [m.slug, m.displayName]),
              ),
            },
            api: { type: "openai-responses", baseUrl: "https://api.openai.com/v1" },
            personalModelIds: profile.models.map((m) => m.slug),
            modelOrder: profile.models.map((m) => m.slug),
          },
        }));
        const models = state.profiles.flatMap((profile) =>
          profile.models.map((model) => ({
            providerId: `chatgpt-subscription:${profile.profileId}`,
            modelId: model.slug,
            config: {
              enabled: true,
              properties: {
                requiresMfjsToolSchema: false,
                // 客户端保守上下文调度值，不是账户权限/模型官方窗口声明。
                contextWindow: resolveSubscriptionContextPlan(model.slug).contextWindow,
                // 路线允许图像/文件 input；具体模型权限仍由服务器判定，UI 标注未知。
                inputFormat: {
                  supportsText: true,
                  supportsImage: true,
                  supportsPdf: true,
                  supportsVideo: false,
                  supportsAudio: false,
                },
                outputFormat: { supportsText: true },
                supportsToolCall: true,
                supportsJsonSchemaOutput: false,
                supportsNativeWebSearch: false,
                supportsMidConversationSystem: true,
              },
              optionSpecs: {
                reasoningLevel: {
                  values: ["auto", "low", "medium", "high", "xhigh", "max"],
                  map: 'reasoningLevel == "auto" ? {} : {"reasoning": {"effort": reasoningLevel}}',
                },
                maxOutputTokens: { max: 16384, map: "{}" },
              },
            },
          })),
        );
        const json = JSON.stringify({
          version: 1,
          providers,
          models: { providerModelRules: models, manualProviderModelRules: [] },
        });
        if (json !== previous) {
          await atomicWritePrivateTextFile(file, json);
          previous = json;
        }
      });
    queue = operation;
    return operation;
  };
}
