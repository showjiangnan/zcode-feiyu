// Modified by ZCode Feiyu.
import { ChatGPTSubscriptionError } from "./errors.js";
import {
  chatGPTModelCapabilitiesSchema,
  chatGPTSubscriptionModelSchema,
} from "@zcode/shared/chatgpt-subscription-catalog";
import { subscriptionModelSchema } from "./records.js";
import type { z } from "zod";
import { resolveSubscriptionContextPlan } from "./contextPlan.js";

const capabilityFields = {
  service_tiers: "serviceTiers",
  additional_speed_tiers: "additionalSpeedTiers",
  default_reasoning_level: "defaultReasoningLevel",
  supported_reasoning_levels: "supportedReasoningLevels",
  default_reasoning_summary: "defaultReasoningSummary",
  context_window: "contextWindow",
  max_context_window: "maxContextWindow",
  effective_context_window_percent: "effectiveContextWindowPercent",
  input_modalities: "inputModalities",
  supports_image_detail_original: "supportsImageDetailOriginal",
  supports_search_tool: "supportsSearchTool",
  web_search_tool_type: "webSearchToolType",
  apply_patch_tool_type: "applyPatchToolType",
  experimental_supported_tools: "experimentalSupportedTools",
  shell_type: "shellType",
  tool_mode: "toolMode",
  use_responses_lite: "useResponsesLite",
  node_repl_disabled: "nodeReplDisabled",
  node_repl_auto_review_required: "nodeReplAutoReviewRequired",
  multi_agent_version: "multiAgentVersion",
  multi_agent_reasoning_effort: "multiAgentReasoningEffort",
  support_verbosity: "supportVerbosity",
  default_verbosity: "defaultVerbosity",
  supports_reasoning_effort_updates: "supportsReasoningEffortUpdates",
  supports_experimental_context: "supportsExperimentalContext",
  supported_in_api: "supportedInApi",
  available_access_programs: "availableAccessPrograms",
  truncation_policy: "truncationPolicy",
  description: "description",
  priority: "priority",
  availability_nux: "availabilityNux",
  upgrade: "upgrade",
} as const;
const privateFields = [
  "model_messages",
  "include_skills_usage_instructions",
  "include_plugin_usage_instructions",
  "include_apps_usage_instructions",
  "comp_hash",
];

export function parseSubscriptionCatalog(
  value: unknown,
): z.infer<typeof subscriptionModelSchema>[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { models?: unknown }).models))
    throw new ChatGPTSubscriptionError("catalog_invalid");
  const rows = (value as { models: unknown[] }).models;
  if (rows.length > 10000) throw new ChatGPTSubscriptionError("catalog_invalid");
  const seen = new Set<string>();
  const result: z.infer<typeof subscriptionModelSchema>[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") throw new ChatGPTSubscriptionError("catalog_invalid");
    const entry = row as Record<string, unknown>;
    if (entry.visibility !== "list") continue;
    if (
      typeof entry.slug !== "string" ||
      !entry.slug ||
      typeof entry.display_name !== "string" ||
      !entry.display_name ||
      seen.has(entry.slug)
    )
      throw new ChatGPTSubscriptionError("catalog_invalid");
    seen.add(entry.slug);
    const capabilityData = Object.fromEntries(
      Object.entries(capabilityFields)
        .filter(([key]) => entry[key] != null)
        .map(([key, name]) => [name, entry[key]]),
    );
    // 只投影已知子字段；未来目录附加描述不应使整份有效目录无法刷新。
    for (const [key, fields] of [
      ["serviceTiers", ["id", "name", "description"]],
      ["supportedReasoningLevels", ["effort", "description"]],
    ] as const) {
      const rows = capabilityData[key];
      if (Array.isArray(rows))
        capabilityData[key] = rows.map((row: unknown) => {
          if (!row || typeof row !== "object" || Array.isArray(row)) return row;
          return Object.fromEntries(
            fields
              .filter((field) => field in row)
              .map((field) => [field, (row as Record<string, unknown>)[field]]),
          );
        });
    }
    const truncation = capabilityData.truncationPolicy;
    if (truncation && typeof truncation === "object" && !Array.isArray(truncation))
      capabilityData.truncationPolicy = Object.fromEntries(
        ["mode", "limit"]
          .filter((field) => field in truncation)
          .map((field) => [field, (truncation as Record<string, unknown>)[field]]),
      );
    const parsed = chatGPTModelCapabilitiesSchema.safeParse(capabilityData);
    if (!parsed.success) throw new ChatGPTSubscriptionError("catalog_invalid");
    const capabilities = parsed.data;
    const nativeMetadata = Object.fromEntries(
      privateFields.filter((key) => entry[key] != null).map((key) => [key, entry[key]]),
    );
    const model = subscriptionModelSchema.safeParse({
      slug: entry.slug,
      displayName: entry.display_name,
      ...(capabilities.contextWindow
        ? { contextWindow: capabilities.contextWindow, contextWindowSource: "subscription-catalog" }
        : resolveSubscriptionContextPlan(entry.slug)),
      ...(capabilities.inputModalities ? { inputModalities: capabilities.inputModalities } : {}),
      ...(capabilities.supportedReasoningLevels
        ? { reasoningLevels: capabilities.supportedReasoningLevels.map((level) => level.effort) }
        : {}),
      ...(Object.keys(capabilityData).length ? { capabilities } : {}),
      ...(Object.keys(nativeMetadata).length ? { nativeMetadata } : {}),
    });
    if (!model.success) throw new ChatGPTSubscriptionError("catalog_invalid");
    result.push(model.data);
  }
  return result;
}

/** 原生模板属于私有目录；公开 view 保留服务器窗口，不再被静态规划覆盖。 */
export function publicSubscriptionModel(model: z.infer<typeof subscriptionModelSchema>) {
  const { nativeMetadata: _private, ...visible } = model;
  const capabilities = model.capabilities;
  return chatGPTSubscriptionModelSchema.parse({
    ...resolveSubscriptionContextPlan(model.slug),
    ...visible,
    ...(capabilities?.contextWindow
      ? { contextWindow: capabilities.contextWindow, contextWindowSource: "subscription-catalog" }
      : {}),
    ...(capabilities?.inputModalities ? { inputModalities: capabilities.inputModalities } : {}),
    ...(capabilities?.supportedReasoningLevels
      ? { reasoningLevels: capabilities.supportedReasoningLevels.map((level) => level.effort) }
      : {}),
  });
}
