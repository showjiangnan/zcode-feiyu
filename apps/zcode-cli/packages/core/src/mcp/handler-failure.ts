// Modified by ZCode Feiyu contributors (2026).
import type { McpToolCallResult, ModelMessageContent } from "@zcode/contracts";
import type { ToolHandlerFailure } from "../tool/types.js";

export function toMcpToolHandlerFailure(
  output: McpToolCallResult,
  modelContent: ModelMessageContent,
): ToolHandlerFailure {
  const structured = record(output.structuredContent);
  const error = record(structured?.error);
  const code = error?.code;
  const text = output.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  return {
    result: false,
    errorCode:
      (typeof code === "string" && code.trim()) ||
      (typeof code === "number" && Number.isFinite(code))
        ? (code as string | number)
        : "mcp_tool_error",
    message:
      typeof error?.message === "string" && error.message.trim()
        ? error.message
        : text.trim().slice(0, 4096) || "MCP tool returned an error",
    output,
    modelContent,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
