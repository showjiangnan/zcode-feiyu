// Modified by ZCode Feiyu.
import type { SessionEvent, ModelCompletePayload, ModelUsage } from "@zcode/contracts";
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import { getModelUsageContextTokens } from "@zcode/contracts";
import type { ProductProjection } from "./product-projection.js";

export function onModelComplete(this: ProductProjection, event: SessionEvent): ConversationDelta[] {
  const payload = event.payload as ModelCompletePayload;
  const retryClearDeltas = this["acceptsActiveModelEvent"](event) ? this["setApiRetry"](null) : [];
  // 与旧 reducer 同一裁决：只有主会话往返才能覆盖 context 水位。
  const isMainTurn =
    payload.querySource !== undefined
      ? payload.querySource === "main_turn"
      : payload.stopReason !== "tool_internal";
  if (isMainTurn) this["outputContinuationTextRowId"] = null;
  if (
    isMainTurn &&
    payload.stopReason?.trim().toLowerCase() === "length" &&
    payload.toolCallCount === 0
  ) {
    const lastVisibleRow = this["snapshot"].rows.window.at(-1);
    if (
      lastVisibleRow?.kind === "assistantText" &&
      lastVisibleRow.turnId === this["turnIdOf"](event) &&
      lastVisibleRow.state === "complete"
    ) {
      this["outputContinuationTextRowId"] = lastVisibleRow.rowId;
    }
  }
  // subagent ModelComplete 的 usage 仍不是主会话水位，但它携带的
  // fileChanges 是 child session 自己的 workspace 事实，必须独立投影到 child turn header。
  const supportsFileChangeSummary = isMainTurn || payload.querySource === "subagent";
  const usage = payload.usage as ModelUsage;
  const deltas: ConversationDelta[] = [];
  const turnId = this["turnIdOf"](event);
  const headerRowId = this["turnHeaderRowIdByTurnId"].get(turnId);
  const headerRow = headerRowId !== undefined ? this["findRow"](headerRowId) : undefined;
  if (headerRow?.kind === "turnHeader") {
    const fileChanges =
      supportsFileChangeSummary && payload.fileChanges && payload.fileChanges.files > 0
        ? {
            fileChanges: {
              additions: payload.fileChanges.additions,
              deletions: payload.fileChanges.deletions,
              files: payload.fileChanges.files,
              // Bug 根因：该条件对象随后与 headerRow 展开合并，TS 会把字面量扩宽为
              // string，导致 CLI 启动前构建无法满足 TurnFileChangeSummary 契约。
              state: "active" as const,
            },
          }
        : {};
    if (isMainTurn || "fileChanges" in fileChanges) {
      deltas.push({
        op: "row.upserted",
        row: {
          ...headerRow,
          ...fileChanges,
          // Bug 根因：Renderer 观察 running 快照的时机不可靠，continuous 可合并更新，
          // replayable 也可能首次恢复即终态。单 Turn token 必须在权威事件投影中累计。
          ...(isMainTurn
            ? { outputTokens: (headerRow.outputTokens ?? 0) + (usage.outputTokens ?? 0) }
            : {}),
        },
      });
    }
  }
  if (!isMainTurn) return [...deltas, ...retryClearDeltas];
  const usedTokens = getModelUsageContextTokens(usage) ?? 0;
  this["contextWindowState"].usedTokens = usedTokens;
  const maxTokens = payload.contextWindow ?? this["contextWindowState"].maxTokens;
  const cumulative = this["snapshot"].usage.cumulative;
  deltas.push({
    op: "state.updated",
    patch: {
      usage: {
        // Bug 原因：registry 已显式清除窗口时，缺少 contextWindow 的 ModelComplete
        // 过去会用 0 重建对象，破坏未知容量语义。token 继续在侧状态和累计值中更新。
        contextWindow:
          maxTokens === null
            ? null
            : {
                usedTokens,
                maxTokens,
                autoCompactThresholdTokens:
                  this["snapshot"].usage.contextWindow?.autoCompactThresholdTokens ?? null,
                ...(payload.cacheHit ? { cache: payload.cacheHit } : {}),
                ...(payload.contextUsageBreakdown && payload.contextUsageBreakdown.length > 0
                  ? { breakdown: payload.contextUsageBreakdown }
                  : {}),
              },
        cumulative: {
          inputTokens: cumulative.inputTokens + (usage.inputTokens ?? 0),
          outputTokens: cumulative.outputTokens + (usage.outputTokens ?? 0),
          cacheReadTokens: cumulative.cacheReadTokens + (usage.cacheReadTokens ?? 0),
          cacheWriteTokens: cumulative.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
        },
      },
    },
  });
  // ModelComplete 是缺少 network completed 事件时的成功兜底，不能让重试提示悬挂。
  deltas.push(...retryClearDeltas);
  return deltas;
}
