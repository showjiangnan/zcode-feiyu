// Modified by ZCode Feiyu.
import { type ModelMessageContent, type Model, type TokenUsageInfo } from "@zcode/contracts";

import { type SystemReminderSource } from "../system-reminder/source.js";

import {
  type ToolCallInput,
  type ReasoningContentInput,
  type ModelInputMessage,
  type RuntimeMessageMetadata,
  type RuntimeMessageEntry,
  type CacheStats,
  type MessageHistory,
} from "./message-history-types.js";
import {
  countContextPrefixMessages,
  systemReminderAttachmentEntry,
  createRuntimeUserEntry,
  createRuntimeToolResultEntry,
  cloneEntryInput,
  cloneRuntimeMessageEntry,
  cloneTokenUsageInfo,
  cloneReasoningBlock,
} from "./message-history-entry.js";
export {
  type ToolCallInput,
  type ReasoningContentInput,
  type ModelInputMessage,
  type RuntimeMessageSource,
  type RuntimeMessageMetadata,
  type RuntimeMessageMessageEntry,
  type RuntimeAttachmentEntry,
  type RuntimeMessageEntry,
  type CacheStats,
  type MessageHistory,
} from "./message-history-types.js";
export {
  countContextPrefixMessages,
  systemReminderRuntimeMetadata,
  realUserRuntimeMetadata,
  legacySyntheticRuntimeMetadata,
  todoReminderRuntimeMetadata,
  systemReminderAttachmentEntry,
  createRuntimeUserEntry,
  createRuntimeAssistantEntry,
  createRuntimeToolResultEntry,
  isKnownSystemReminderSource,
  cloneRuntimeMessageEntry,
  invalidateRuntimeTokenUsage,
  cloneRuntimeMessageMetadata,
  isRuntimeAttachmentEntry,
  cloneModelInputMessage,
  cloneModelMessageContent,
} from "./message-history-entry.js";
// 按职责拆分；保留原始规则、执行顺序与状态所有者。

// ============================================================
// Message History Implementation
// ============================================================

export class MessageHistoryImpl implements MessageHistory {
  private entries: RuntimeMessageEntry[] = [];
  private cacheStats: CacheStats = {
    totalMessages: 0,
    cachedMessages: 0,
    lastCacheHit: false,
  };

  init(systemPromptOrMessages?: string | Array<ModelInputMessage | RuntimeMessageEntry>): void {
    this.entries = [];

    if (typeof systemPromptOrMessages === "string" && systemPromptOrMessages.length > 0) {
      this.entries.push({
        message: {
          role: "system",
          content: systemPromptOrMessages,
        },
      });
    } else if (Array.isArray(systemPromptOrMessages)) {
      this.entries.push(...systemPromptOrMessages.map(cloneEntryInput));
    }

    this.cacheStats = {
      totalMessages: this.entries.length,
      cachedMessages: countContextPrefixMessages(this.entries),
      lastCacheHit: false,
    };
  }

  addUser(content: ModelMessageContent, metadata?: RuntimeMessageMetadata): void {
    this.entries.push(createRuntimeUserEntry(content, metadata));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addAttachment(source: SystemReminderSource, content: string): void {
    this.entries.push(systemReminderAttachmentEntry(source, content));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addEntries(entries: readonly RuntimeMessageEntry[]): void {
    this.entries.push(...entries.map(cloneRuntimeMessageEntry));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addAssistant(
    content: string,
    toolCalls?: ToolCallInput[],
    reasoning?: ReasoningContentInput[],
    model?: Pick<Model, "providerId" | "modelId">,
    tokens?: TokenUsageInfo,
  ): void {
    const reasoningBlocks = reasoning?.map((block) => cloneReasoningBlock(block)) ?? [];
    this.entries.push({
      message: {
        role: "assistant",
        content:
          reasoningBlocks.length > 0
            ? [
                ...reasoningBlocks,
                ...(content.length > 0 ? [{ type: "text" as const, text: content }] : []),
              ]
            : content,
        toolCalls: toolCalls?.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: tc.input,
        })),
        ...(model ? { providerId: model.providerId, modelId: model.modelId } : {}),
      },
      ...(tokens ? { tokens: cloneTokenUsageInfo(tokens) } : {}),
    });
    this.cacheStats.totalMessages = this.entries.length;
  }

  addToolResult(
    toolCallId: string,
    toolName: string,
    content: ModelMessageContent,
    success: boolean,
    isError = !success,
  ): void {
    this.entries.push(createRuntimeToolResultEntry(toolCallId, toolName, content, isError));
    this.cacheStats.totalMessages = this.entries.length;
  }

  borrowReadOnlyRuntimeEntries(): readonly RuntimeMessageEntry[] {
    return this.entries;
  }

  toRuntimeEntries(): RuntimeMessageEntry[] {
    return this.entries.map(cloneRuntimeMessageEntry);
  }

  replaceMessages(messages: readonly (ModelInputMessage | RuntimeMessageEntry)[]): void {
    this.entries = messages.map(cloneEntryInput);
    this.cacheStats = {
      totalMessages: this.entries.length,
      cachedMessages: countContextPrefixMessages(this.entries),
      lastCacheHit: false,
    };
  }

  getMessageCount(): number {
    return this.entries.length;
  }

  getCacheStats(): CacheStats {
    return { ...this.cacheStats };
  }

  setCacheHit(tokens?: number): void {
    this.cacheStats.lastCacheHit = true;
    this.cacheStats.cacheReadTokens = tokens;
    // Mark all messages as potentially cached
    this.cacheStats.cachedMessages = this.entries.length;
  }

  setCacheMiss(): void {
    this.cacheStats.lastCacheHit = false;
    this.cacheStats.cacheReadTokens = undefined;
    this.cacheStats.cachedMessages = countContextPrefixMessages(this.entries);
  }

  reset(): void {
    const contextPrefixMessages = this.entries.slice(0, countContextPrefixMessages(this.entries));
    this.entries = contextPrefixMessages.map(cloneRuntimeMessageEntry);
    this.cacheStats = {
      totalMessages: contextPrefixMessages.length,
      cachedMessages: contextPrefixMessages.length,
      lastCacheHit: false,
    };
  }
}

// ============================================================
// Factory
// ============================================================

export function createMessageHistory(): MessageHistory {
  return new MessageHistoryImpl();
}
