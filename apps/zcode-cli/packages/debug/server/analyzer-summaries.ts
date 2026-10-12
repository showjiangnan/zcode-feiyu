// Modified by ZCode Feiyu.
import { isRecord, numberValue, stringValue } from "./sources.js";
import type { DbMessageRecord, DbPartRecord, EventRecord } from "./types.js";
import { modelName, arrayValue, stringifyTimelineValue } from "./analyzer-values.js";

export function extractUsage(payload?: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const usage = isRecord(payload?.usage) ? payload.usage : payload;
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }

  return {
    inputTokens: numberValue(usage.inputTokens) ?? numberValue(usage.input) ?? 0,
    outputTokens: numberValue(usage.outputTokens) ?? numberValue(usage.output) ?? 0,
    totalTokens: numberValue(usage.totalTokens) ?? numberValue(usage.total) ?? 0,
    cacheReadTokens:
      numberValue(usage.cacheReadTokens) ??
      numberValue(isRecord(usage.cache) ? usage.cache.read : undefined) ??
      0,
    cacheWriteTokens:
      numberValue(usage.cacheWriteTokens) ??
      numberValue(isRecord(usage.cache) ? usage.cache.write : undefined) ??
      0,
  };
}

export function summarizeEvent(event: EventRecord): string {
  const payload = event.payload;
  switch (event.type) {
    case "model_request": {
      const title = `模型请求 ${modelName(payload) ?? ""}`.trim();
      const messages = summarizeProviderMessages(payload);
      return messages ? `${title}\n${messages}` : title;
    }
    case "model_complete": {
      const usage = extractUsage(payload);
      const title = `模型完成，${usage.totalTokens || usage.inputTokens + usage.outputTokens} Token`;
      const content = textFromPayload(payload);
      return content ? `${title}\n${content}` : title;
    }
    case "tool_call_scheduled":
    case "tool_call_started":
    case "tool_call_result":
    case "tool_call_error":
      return [
        `${stringValue(payload?.toolName) ?? "工具"} ${stringValue(payload?.toolCallId) ?? ""}`.trim(),
        textFromPayload(payload),
      ]
        .filter(Boolean)
        .join("\n");
    case "turn_complete":
      return `轮次完成：${stringValue(payload?.resultType) ?? "success"}`;
    case "user_message":
    case "assistant_message":
      return textFromPayload(payload) ?? String(payload?.content ?? event.type);
    default:
      return [event.type, textFromPayload(payload)].filter(Boolean).join("\n");
  }
}

export function summarizeDbMessage(message: DbMessageRecord): string {
  const text = stringValue(message.data.text) ?? stringValue(message.data.content);
  const title = `${formatRole(message.role)}消息 ${message.id}`;
  return text ? `${title}: ${text}` : title;
}

export function summarizeProviderMessages(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const messages = arrayValue(payload?.messages).filter(isRecord);
  if (messages.length === 0) return undefined;

  return messages
    .map((message, index) => {
      const role = stringValue(message.role) ?? `message ${index + 1}`;
      const content = textFromPayload(message) ?? stringifyTimelineValue(message);
      return `${role}: ${content}`;
    })
    .join("\n");
}

export function firstUserMessageFromEvent(event: EventRecord): string | undefined {
  if (event.type === "user_message") {
    return textFromPayload(event.payload);
  }

  const messages = arrayValue(event.payload?.messages).filter(isRecord);
  const userMessage = messages.find((message) => stringValue(message.role) === "user");
  return userMessage ? textFromPayload(userMessage) : undefined;
}

export function textFromDbMessage(message: DbMessageRecord): string | undefined {
  return textFromPayload(message.data);
}

export function textFromDbParts(parts: DbPartRecord[] | undefined): string | undefined {
  const textParts = parts
    ?.map((part) => textFromPayload(part.data))
    .filter((text): text is string => Boolean(text?.trim()));
  if (!textParts || textParts.length === 0) return undefined;
  return textParts.join("\n");
}

export function textFromPayload(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  return (
    textFromContent(payload.content) ??
    textFromContent(payload.text) ??
    textFromContent(payload.message)
  );
}

export function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isRecord(part)) return "";
        return textFromContent(part.text) ?? textFromContent(part.content) ?? "";
      })
      .filter(Boolean)
      .join(" ");
  }
  if (isRecord(content)) {
    return textFromContent(content.text) ?? textFromContent(content.content);
  }
  return undefined;
}

export function formatRole(role?: string): string {
  switch (role) {
    case "system":
      return "system ";
    case "user":
      return "user ";
    case "assistant":
      return "assistant ";
    case "tool":
      return "tool ";
    default:
      return "";
  }
}

export function summarizeDbPart(part: DbPartRecord): string {
  const text = stringValue(part.data.text) ?? stringValue(part.data.output);
  return text ? `${part.type ?? "片段"}: ${text}` : `${part.type ?? "片段"} ${part.id}`;
}
