// Modified by ZCode Feiyu.
import type { SessionEvent, ModelSelectedPayload } from "@zcode/contracts";
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import {
  cloneSparseModelSelection,
  sameSparseModelSelection,
} from "./product-projection-hook-invocation-row-content.js";
import { positiveInteger } from "./product-projection-stream-recovery-reason-code.js";
import { HYDRATION_TRACE_ID } from "./projection-state.js";
import type { ProductProjection } from "./product-projection.js";

export function onModelSelected(this: ProductProjection, event: SessionEvent): ConversationDelta[] {
  const payload = event.payload as ModelSelectedPayload;
  // Bug 原因：把 fresh child 身份另存为 pending side state 后，原子投影 clone/adopt
  // 漏复制该字段，实时 marker 会消失。显式 null 直接复用模型基线表达 ∅→X，
  // 公共投影不再识别 Subagent 身份；后续选型只更新 config，不覆盖上一轮实际模型。
  if (payload.previousModelSelection === null) {
    this["lastTurnModel"] = { kind: "sourceLess" };
  }
  const prev = this["snapshot"].config;
  const provider = payload.modelSelection.providerId;
  const model = payload.modelSelection.modelId;
  const thought =
    payload.effectiveReasoningLevel ?? payload.modelSelection.options?.reasoningLevel ?? "";
  const modelSelection = cloneSparseModelSelection(payload.modelSelection);
  const thoughtLevels = payload.supportedThoughtLevels
    ? [...payload.supportedThoughtLevels]
    : prev.thoughtLevels;
  const contextWindow =
    payload.contextWindow === null
      ? null
      : payload.contextWindow !== undefined
        ? positiveInteger(payload.contextWindow, 0) || undefined
        : undefined;
  // Bug 原因：旧事件只更新 config，runtime 虽已切到新模型，历史 usage 的 maxTokens
  // 仍停在源模型，直到下一次 ModelComplete 才偶然校准。窗口属于已应用模型能力，
  // 必须在同一个 ModelSelected 中提交；usedTokens 仍保留历史上下文事实。
  if (contextWindow !== undefined) {
    this["contextWindowState"].touchedByEvent = true;
    this["contextWindowState"].maxTokens =
      contextWindow !== null && contextWindow > 0 ? contextWindow : null;
  }
  const previousContextWindow = this["snapshot"].usage.contextWindow;
  if (previousContextWindow) {
    this["contextWindowState"].usedTokens = previousContextWindow.usedTokens;
  }
  const contextWindowChanged =
    contextWindow !== undefined &&
    (contextWindow === null
      ? previousContextWindow !== null
      : previousContextWindow === null || previousContextWindow.maxTokens !== contextWindow);
  // 日志事件触碰过模型选型后，种子不再覆盖（同值 return 也算触碰）。
  // 冷恢复合成的 ModelSelected（HYDRATION_TRACE_ID）例外：它只是从 message 事实
  // 重建历史选型供 modelChange marker 使用，不是权威选型动作；重放后 seedConfig
  // 仍以 runtime 真值（resume 已回写的上次/草稿选型）收口。
  if (String(event.traceId) !== HYDRATION_TRACE_ID) {
    this["configModelTouchedByEvent"] = true;
    if (payload.supportedThoughtLevels !== undefined) {
      this["configThoughtLevelsTouchedByEvent"] = true;
    }
  }
  // 选型事件只更新 config，不在选型时落 modelChange
  // marker——切换动作是意向，marker 归 onTurnStarted 按「与上一轮实际选型不同」
  // 裁决（见彼处注释与 Bug 背景）。
  const configChanged = !(
    prev.provider === provider &&
    prev.model === model &&
    sameSparseModelSelection(prev.modelSelection, modelSelection) &&
    prev.thought === thought &&
    prev.thoughtLevels.length === thoughtLevels.length &&
    prev.thoughtLevels.every((value, index) => value === thoughtLevels[index])
  );
  const modelTransition =
    payload.origin === "registryFallback" &&
    payload.previousModelSelection != null &&
    (payload.previousModelSelection.providerId !== provider ||
      payload.previousModelSelection.modelId !== model)
      ? {
          eventId: String(event.id),
          origin: payload.origin,
          from: {
            provider: payload.previousModelSelection.providerId,
            model: payload.previousModelSelection.modelId,
          },
          to: { provider, model },
        }
      : undefined;
  if (!configChanged && !contextWindowChanged && modelTransition === undefined) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: {
        ...(configChanged
          ? { config: { ...prev, modelSelection, provider, model, thought, thoughtLevels } }
          : {}),
        // Bug 原因：仅投影 config 会丢失“由 registry fallback 触发”的来源，
        // renderer 无法安全地区分自动恢复和显式/历史切换。保留事件 ID 与起止身份，
        // 具体 toast 仍只由客户端在实时 online delivery 边界触发。
        ...(modelTransition ? { modelTransition } : {}),
        ...(contextWindowChanged
          ? {
              usage: {
                ...this["snapshot"].usage,
                // Bug 原因：null 是 registry 清除显式窗口的权威事件，必须清空整个
                // usage.contextWindow；字段缺失才保留旧事件兼容语义。
                contextWindow:
                  contextWindow === null
                    ? null
                    : previousContextWindow
                      ? { ...previousContextWindow, maxTokens: contextWindow }
                      : {
                          usedTokens: this["contextWindowState"].usedTokens,
                          maxTokens: contextWindow,
                          autoCompactThresholdTokens: null,
                        },
              },
            }
          : {}),
      },
    },
  ];
}
