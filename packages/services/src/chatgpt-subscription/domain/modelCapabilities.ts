// Modified by ZCode Feiyu.
import type { ChatGPTSubscriptionModel } from "@zcode/shared";
import { getSubscriptionEffectiveContextWindow } from "@zcode/shared/chatgpt-subscription-catalog";

const publicEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** 目录事实与公开订阅路线取交集，原生执行偏好不成为本地工具/审批配置。 */
export function subscriptionModelConfiguration(model: ChatGPTSubscriptionModel) {
  const capabilities = model.capabilities;
  const modalities = capabilities?.inputModalities ?? model.inputModalities;
  const efforts =
    capabilities?.supportedReasoningLevels?.map((entry) => entry.effort) ?? model.reasoningLevels;
  const values =
    efforts === undefined
      ? ["auto", "low", "medium", "high", "xhigh", "max"]
      : ["auto", ...new Set(efforts.filter((effort) => publicEfforts.has(effort)))];
  return {
    enabled: true,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: getSubscriptionEffectiveContextWindow(model),
      inputFormat: {
        supportsText: modalities === undefined || modalities.includes("text"),
        supportsImage: modalities === undefined || modalities.includes("image"),
        supportsPdf:
          modalities === undefined || modalities.includes("image") || modalities.includes("file"),
        supportsVideo: false,
        supportsAudio: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch:
        capabilities?.supportsSearchTool === true &&
        (capabilities.webSearchToolType === undefined ||
          ["web_search", "web_search_preview"].includes(capabilities.webSearchToolType)),
      supportsMidConversationSystem: true,
    },
    optionSpecs: {
      reasoningLevel: {
        values,
        map: 'reasoningLevel == "auto" ? {} : {"reasoning": {"effort": reasoningLevel}}',
      },
      maxOutputTokens: { max: 16384, map: "{}" },
    },
  };
}
