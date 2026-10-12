// Modified by ZCode Feiyu.
import type {
  ContextSectionSource,
  ContextUsageCategory,
  TokenConfidence,
  TokenMethod,
  TimelineItem,
} from "../src/shared.js";
import { isRecord, stringValue } from "./sources.js";
import type { EventRecord, LogRecord } from "./types.js";

export function eventToolCallId(payload?: Record<string, unknown>): string | undefined {
  return stringValue(payload?.toolCallId);
}

export function eventToolName(payload?: Record<string, unknown>): string | undefined {
  return stringValue(payload?.toolName) ?? stringValue(payload?.name);
}

export function subagentLabel(event: EventRecord): string {
  return (
    stringValue(event.payload?.name) ??
    stringValue(event.payload?.subagentId) ??
    stringValue(event.payload?.subagentSessionId) ??
    "子 Agent"
  );
}

export function modelName(payload?: Record<string, unknown>): string | undefined {
  const modelSelection = isRecord(payload?.modelSelection) ? payload.modelSelection : undefined;
  return stringValue(modelSelection?.modelId) ?? stringValue(payload?.model);
}

export function isContextBuiltLog(log: LogRecord): boolean {
  return log.message === "Context built" || log.event === "context.built";
}

export function isContextUsageSnapshotLog(log: LogRecord): boolean {
  return log.message === "Context usage snapshot" || log.event === "context_usage_snapshot";
}

export function contextUsageSourceValue(value: unknown): ContextUsageCategory["source"] {
  switch (value) {
    case "system_prompt":
    case "meta_user_context":
    case "skills":
    case "tool_prompt":
    case "system_tool_schemas":
    case "mcp_tool_schemas":
    case "messages":
    case "other":
      return value;
    default:
      return "other";
  }
}

export function tokenMethodValue(value: unknown): TokenMethod | undefined {
  switch (value) {
    case "estimated":
    case "provider_count":
    case "proportional_estimate":
    case "provider_usage":
      return value;
    default:
      return undefined;
  }
}

export function tokenConfidenceValue(value: unknown): TokenConfidence | undefined {
  switch (value) {
    case "high":
    case "medium":
    case "low":
      return value;
    default:
      return undefined;
  }
}

export function categorizeSection(nameOrSource: string): ContextSectionSource {
  const normalized = nameOrSource.toLowerCase();
  if (normalized.includes("skill") || normalized.includes("技能")) return "skills";
  if (normalized.includes("tool") || normalized.includes("工具")) return "tools";
  if (
    normalized.includes("identity") ||
    normalized.includes("system") ||
    normalized.includes("instruction") ||
    normalized.includes("env") ||
    normalized.includes("project") ||
    normalized.includes("prompt") ||
    normalized.includes("user_instructions") ||
    normalized.includes("project_context")
  ) {
    return "system_prompt";
  }
  return "other";
}

export function normalizeLogLevel(level?: string): TimelineItem["severity"] {
  switch (level) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return level;
    default:
      return undefined;
  }
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringifyTimelineValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function preview(text: string, maxLength = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

export function estimateTokens(text: string): number {
  const chineseChars = text.match(/[一-鿿]/g)?.length ?? 0;
  const otherChars = text.length - chineseChars;
  return Math.ceil((chineseChars * 2 + otherChars) / 3);
}

export function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "section"
  );
}

export function compareIsoAsc(left?: string, right?: string): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right);
}

export function compareIsoDesc(left?: string, right?: string): number {
  return compareIsoAsc(right, left);
}
