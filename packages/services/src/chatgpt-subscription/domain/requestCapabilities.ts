// Modified by ZCode Feiyu.
import type { ChatGPTSubscriptionModel } from "@zcode/shared";
import { getModelSpeedOptions } from "@zcode/shared/model-speed";
import { getSubscriptionFastServiceTier } from "@zcode/shared/chatgpt-subscription-catalog";
import { ChatGPTSubscriptionError } from "./errors.js";
import { subscriptionModelConfiguration } from "./modelCapabilities.js";

function record(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ChatGPTSubscriptionError("request_invalid");
  return value as Record<string, unknown>;
}

/** 原执行 binding 的目录快照提供许可；请求体不携带自报能力。 */
export function applySubscriptionRequestCapabilities(
  body: Record<string, unknown>,
  model: ChatGPTSubscriptionModel,
) {
  const capabilities = model.capabilities;
  const config = subscriptionModelConfiguration(model);
  const tier = body.service_tier;
  const speed =
    tier === "priority" || tier === "fast"
      ? "fast"
      : tier === "ultrafast"
        ? "ultrafast"
        : "standard";
  const allowed = getModelSpeedOptions(
    {
      api: { type: "openai-responses", baseUrl: "https://api.openai.com/v1" },
      access: {
        type: "chatgpt-subscription",
        entitled: true,
        modelCapabilities: capabilities ? { [model.slug]: capabilities } : undefined,
      },
    },
    model.slug,
  );
  if (!allowed.includes(speed))
    throw new ChatGPTSubscriptionError("model_speed_not_supported", 400);

  const reasoning = { ...record(body.reasoning) },
    text = { ...record(body.text) };
  if (
    reasoning.effort === undefined &&
    capabilities?.defaultReasoningLevel &&
    config.optionSpecs.reasoningLevel.values.includes(capabilities.defaultReasoningLevel)
  )
    reasoning.effort = capabilities.defaultReasoningLevel;
  if (
    reasoning.effort !== undefined &&
    capabilities?.supportedReasoningLevels !== undefined &&
    !config.optionSpecs.reasoningLevel.values.includes(String(reasoning.effort))
  )
    throw new ChatGPTSubscriptionError("model_reasoning_not_supported", 400);
  if (
    reasoning.summary === undefined &&
    capabilities?.defaultReasoningSummary &&
    ["auto", "concise", "detailed"].includes(capabilities.defaultReasoningSummary)
  )
    reasoning.summary = capabilities.defaultReasoningSummary;
  if (text.verbosity !== undefined && capabilities?.supportVerbosity === false)
    throw new ChatGPTSubscriptionError("model_verbosity_not_supported", 400);
  if (
    text.verbosity === undefined &&
    capabilities?.supportVerbosity === true &&
    capabilities.defaultVerbosity &&
    ["low", "medium", "high"].includes(capabilities.defaultVerbosity)
  )
    text.verbosity = capabilities.defaultVerbosity;

  for (const item of body.input as unknown[]) {
    if (
      item &&
      typeof item === "object" &&
      "content" in item &&
      typeof item.content === "string" &&
      !config.properties.inputFormat.supportsText
    )
      throw new ChatGPTSubscriptionError("model_input_not_supported", 400);
    if (!item || typeof item !== "object" || !("content" in item) || !Array.isArray(item.content))
      continue;
    for (const content of item.content) {
      if (!content || typeof content !== "object") continue;
      const part = content as Record<string, unknown>;
      if (["input_audio", "input_video"].includes(String(part.type)))
        throw new ChatGPTSubscriptionError("input_capability_not_supported", 400);
      if (
        (part.type === "input_text" && !config.properties.inputFormat.supportsText) ||
        (part.type === "input_image" && !config.properties.inputFormat.supportsImage) ||
        (part.type === "input_file" && !config.properties.inputFormat.supportsPdf)
      )
        throw new ChatGPTSubscriptionError("model_input_not_supported", 400);
      if (
        part.type === "input_image" &&
        part.detail === "original" &&
        capabilities?.supportsImageDetailOriginal === false
      )
        throw new ChatGPTSubscriptionError("model_image_detail_not_supported", 400);
    }
  }
  return {
    ...body,
    ...(speed === "fast" ? { service_tier: getSubscriptionFastServiceTier(capabilities) } : {}),
    ...(Object.keys(reasoning).length ? { reasoning } : {}),
    ...(Object.keys(text).length ? { text } : {}),
  };
}
