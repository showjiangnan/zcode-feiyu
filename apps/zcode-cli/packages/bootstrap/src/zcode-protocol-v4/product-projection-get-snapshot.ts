// Modified by ZCode Feiyu.
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationNormalizationDiagnostic } from "./event-normalizer.js";
import type { SessionEvent, ModelStreamingPayload } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS } from "@zcode/shared";
import type {
  SessionConfigSeed,
  SessionUsageSeed,
} from "./product-projection-hook-invocation-row-content.js";
import {
  sameSparseModelSelection,
  cloneSparseModelSelection,
} from "./product-projection-hook-invocation-row-content.js";
import type { ProductProjection } from "./product-projection.js";

export function getSnapshot(this: ProductProjection): ConversationSnapshot {
  return this["snapshot"];
}

export function getDroppedContentStreamEventCount(this: ProductProjection): number {
  return this["droppedContentStreamEventCount"];
}

export function getNormalizationDiagnostics(
  this: ProductProjection,
): readonly ConversationNormalizationDiagnostic[] {
  return this["normalizationDiagnostics"];
}

export function establishedStreamingAppend(
  this: ProductProjection,
  event: SessionEvent,
): string | null {
  if (event.type !== SessionEventType.ModelStreaming || !this["isRunning"]()) return null;
  const payload = event.payload as ModelStreamingPayload;
  if (payload.kind === "text_delta" && this["streamingTextRowId"] !== null) return payload.delta;
  if (payload.kind === "reasoning_delta" && this["streamingReasoningRowId"] !== null) {
    return payload.delta;
  }
  if (
    payload.kind === "tool_input_delta" &&
    this["toolRowIdByCallId"].has(String(payload.toolCallId))
  ) {
    const state = this["fileToolInputPreviewByCallId"].get(String(payload.toolCallId));
    if (state) {
      if (
        state.lastPublishedAt !== null &&
        this["ms"](event) - state.lastPublishedAt <
          ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
      ) {
        return "";
      }
      // 上界估算必须包含窗口内累计 suffix；只算当前 delta 会低估下一份 wire snapshot。
      return `${state.pendingAppend}${payload.delta}`;
    }
    return payload.delta;
  }
  return null;
}

export function seedConfig(this: ProductProjection, seed: SessionConfigSeed): void {
  const config = { ...this["snapshot"].config };
  let changed = false;
  if (!config.permissionGrant && seed.permissionGrant) {
    config.permissionGrant = seed.permissionGrant;
    changed = true;
  }
  if (!this["configModelTouchedByEvent"]) {
    if (
      Object.hasOwn(seed, "modelSelection") &&
      !sameSparseModelSelection(config.modelSelection, seed.modelSelection)
    ) {
      // 恢复的空选择也有明确语义，不能因为 falsy 而保留历史事件里的旧选型。
      config.modelSelection = seed.modelSelection
        ? cloneSparseModelSelection(seed.modelSelection)
        : undefined;
      changed = true;
    }
    if (seed.provider !== undefined && config.provider !== seed.provider) {
      config.provider = seed.provider;
      changed = true;
    }
    if (seed.model !== undefined && config.model !== seed.model) {
      config.model = seed.model;
      changed = true;
    }
    if (seed.thought !== undefined && config.thought !== seed.thought) {
      config.thought = seed.thought;
      changed = true;
    }
  }
  const seedThoughtLevels = seed.thoughtLevels;
  if (
    !this["configThoughtLevelsTouchedByEvent"] &&
    seedThoughtLevels !== undefined &&
    (config.thoughtLevels.length !== seedThoughtLevels.length ||
      config.thoughtLevels.some((value, index) => value !== seedThoughtLevels[index]))
  ) {
    config.thoughtLevels = [...seedThoughtLevels];
    changed = true;
  }
  if (!this["configModeTouchedByEvent"] && seed.mode && config.mode !== seed.mode) {
    config.mode = seed.mode;
    changed = true;
  }
  if (
    !this["configOrchestrationTouchedByEvent"] &&
    seed.orchestration &&
    (config.orchestration.revision !== seed.orchestration.revision ||
      config.orchestration.requested !== seed.orchestration.requested ||
      config.orchestration.effective !== seed.orchestration.effective)
  ) {
    config.orchestration = { ...seed.orchestration };
    changed = true;
  }
  if (
    !this["configModeTouchedByEvent"] &&
    seed.planEnabled !== undefined &&
    config.planEnabled !== seed.planEnabled
  ) {
    config.planEnabled = seed.planEnabled;
    changed = true;
  }
  if (changed) {
    this["snapshot"] = { ...this["snapshot"], config };
  }
}

export function seedSharedContextImport(
  this: ProductProjection,
  source: ConversationSnapshot["sharedContextImport"] | null | undefined,
): void {
  const title = source?.title.trim();
  if (!title) return;
  if (
    this["snapshot"].sharedContextImport?.title === title &&
    (
      source as {
        contextId?: string;
      }
    ).contextId ===
      (
        this["snapshot"].sharedContextImport as {
          contextId?: string;
        }
      ).contextId &&
    (
      source as {
        status?: string;
      }
    ).status ===
      (
        this["snapshot"].sharedContextImport as {
          status?: string;
        }
      ).status
  ) {
    return;
  }
  this["snapshot"] = {
    ...this["snapshot"],
    sharedContextImport: {
      ...source,
      title,
    },
  };
}

export function seedUsage(this: ProductProjection, seed: SessionUsageSeed): void {
  const current = this["snapshot"].usage;
  const currentContextWindow = current.contextWindow;
  if (currentContextWindow) {
    this["contextWindowState"].usedTokens = currentContextWindow.usedTokens;
  }
  // 未知容量也有内部用量事实；迟到的恢复种子不能覆盖真实 ModelComplete/Compact 水位。
  if (this["contextWindowState"].usedTokens > 0) {
    return;
  }
  const seededContextWindow = seed.contextWindow;
  if (!Number.isFinite(seededContextWindow.usedTokens) || seededContextWindow.usedTokens <= 0) {
    return;
  }
  const cumulative = {
    inputTokens: seed.cumulative?.inputTokens ?? current.cumulative.inputTokens,
    outputTokens: seed.cumulative?.outputTokens ?? current.cumulative.outputTokens,
    cacheReadTokens: seed.cumulative?.cacheReadTokens ?? current.cumulative.cacheReadTokens,
    cacheWriteTokens: seed.cumulative?.cacheWriteTokens ?? current.cumulative.cacheWriteTokens,
  };
  if (this["contextWindowState"].touchedByEvent) {
    // 同类守卫：显式 ModelSelected.contextWindow（含 null）是日志权威容量，
    // hydration seed 只能补回更准确的 token 事实，不得覆盖 maxTokens 或重新显示 null。
    this["contextWindowState"].usedTokens = seededContextWindow.usedTokens;
    this["snapshot"] = {
      ...this["snapshot"],
      usage: {
        contextWindow: currentContextWindow
          ? {
              ...currentContextWindow,
              usedTokens: seededContextWindow.usedTokens,
            }
          : null,
        cumulative,
      },
    };
    return;
  }
  if (
    seededContextWindow.maxTokens !== null &&
    (!Number.isFinite(seededContextWindow.maxTokens) || seededContextWindow.maxTokens <= 0)
  ) {
    return;
  }
  // 合成历史事件只有零用量占位；种子补真实水位，未知容量不妨碍内部保留 token。
  this["contextWindowState"].usedTokens = seededContextWindow.usedTokens;
  this["contextWindowState"].maxTokens = seededContextWindow.maxTokens;
  this["snapshot"] = {
    ...this["snapshot"],
    usage: {
      contextWindow:
        seededContextWindow.maxTokens === null
          ? null
          : { ...seededContextWindow, maxTokens: seededContextWindow.maxTokens },
      cumulative,
    },
  };
}
