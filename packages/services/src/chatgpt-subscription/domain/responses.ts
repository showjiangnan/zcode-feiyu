// Modified by ZCode Feiyu.
import { ChatGPTSubscriptionError } from "./errors.js";

const forbiddenFields = new Set([
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
]);
const allowedFields = new Set([
  "model",
  "input",
  "instructions",
  "store",
  "stream",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "include",
  "text",
  "service_tier",
]);

export function projectSubscriptionRequest(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ChatGPTSubscriptionError("request_invalid");
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (body[key] !== undefined && (forbiddenFields.has(key) || !allowedFields.has(key)))
      throw new ChatGPTSubscriptionError(
        `unsupported_field_${key.replace(/[^a-z_]/gu, "").slice(0, 60)}`,
      );
  }
  if (typeof body.model !== "string" || !body.model || !Array.isArray(body.input))
    throw new ChatGPTSubscriptionError("request_invalid");
  const input = body.input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new ChatGPTSubscriptionError("input_invalid");
    const entry = item as Record<string, unknown>;
    if (
      entry.type !== undefined &&
      ![
        "message",
        "function_call",
        "function_call_output",
        "custom_tool_call",
        "custom_tool_call_output",
        "reasoning",
      ].includes(String(entry.type))
    )
      throw new ChatGPTSubscriptionError("input_capability_not_supported");
    if (entry.type === "item_reference")
      throw new ChatGPTSubscriptionError("server_history_not_supported");
    if (entry.role === "system") return { ...entry, role: "developer" };
    if (entry.type === "function_call" || entry.type === "custom_tool_call")
      return { ...entry, namespace: "zcode" };
    return entry;
  });
  const tools = body.tools;
  if (tools !== undefined && !Array.isArray(tools))
    throw new ChatGPTSubscriptionError("tools_invalid");
  const names = new Set<string>();
  const localTools = (tools as unknown[] | undefined)?.map((item) => {
    if (!item || typeof item !== "object") throw new ChatGPTSubscriptionError("tools_invalid");
    const tool = item as Record<string, unknown>;
    if (
      !["function", "custom"].includes(String(tool.type)) ||
      typeof tool.name !== "string" ||
      !tool.name ||
      names.has(tool.name)
    )
      throw new ChatGPTSubscriptionError("hosted_tool_not_supported");
    if ("defer_loading" in tool || "allowed_callers" in tool || "async" in tool)
      throw new ChatGPTSubscriptionError("tool_execution_feature_not_supported");
    if (
      tool.type === "function" &&
      (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters))
    )
      throw new ChatGPTSubscriptionError("tool_schema_invalid");
    names.add(tool.name);
    return tool;
  });
  return {
    ...body,
    input,
    store: false,
    stream: true,
    ...(localTools?.length
      ? {
          tools: [
            {
              type: "namespace",
              name: "zcode",
              description: "ZCode local tools",
              tools: localTools,
            },
          ],
        }
      : {}),
  };
}
