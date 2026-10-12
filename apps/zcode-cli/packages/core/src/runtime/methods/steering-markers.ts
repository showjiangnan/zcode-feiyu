// Modified by ZCode Feiyu.
import { SessionEventType, createSessionEvent } from "../deps.js";
import type {
  CollaborationMode,
  ModelSelection,
  ModelSelectionOrigin,
  TraceContext,
} from "../deps.js";
import { cloneModelSelection } from "../model-selection.js";
import { createRuntimeModel } from "./runtime-model.js";

import type { AgentRuntimeInternal } from "../internal.js";

/**
 * （v4 switchModelConfig）：模型选型变化后追加 ModelSelected 事件供投影消费。
 * v4 reducer 的 onModelSelected 依此更新 config.provider/model/thought 和实际 context window，
 * 并（中途切换时）产出 modelChange marker。实际 provider client 切换由 app.setModel 完成，
 * 此处把切换后的完整模型能力元组写入同一个事件。
 */
export async function emitModelSelected(
  this: AgentRuntimeInternal,
  options: {
    modelSelection: ModelSelection;
    model?: import("../deps.js").Model;
    effectiveReasoningLevel?: string;
    previousModelSelection?: ModelSelection | null;
    origin?: ModelSelectionOrigin;
    supportedThoughtLevels?: readonly string[];
    traceContext: TraceContext;
  },
): Promise<void> {
  const model = options.model ?? createRuntimeModel(this, { selection: options.modelSelection });
  const event = createSessionEvent(
    SessionEventType.ModelSelected,
    this.sessionId,
    {
      // 模型切换事件必须从本次创建的 Active Model 读取窗口，不能再复制 Runtime Config。
      contextWindow: model.properties.contextWindow,
      modelSelection: cloneModelSelection(options.modelSelection),
      ...(options.effectiveReasoningLevel
        ? { effectiveReasoningLevel: options.effectiveReasoningLevel }
        : {}),
      // previousModelSelection=null 是显式 ∅→X 模型边界，不能按 truthy 判断丢失。
      ...(options.previousModelSelection !== undefined
        ? {
            previousModelSelection: options.previousModelSelection
              ? cloneModelSelection(options.previousModelSelection)
              : null,
          }
        : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.supportedThoughtLevels
        ? { supportedThoughtLevels: [...options.supportedThoughtLevels] }
        : {}),
    },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

/**
 * （v4 switchCollaborationMode）：命令面切换协作模式后追加 SessionModeChanged 事件。
 * app.setMode 只更新 runtime config + 持久化偏好、不产事件（session-mode-port 的
 * enterPlanMode/exitPlanMode 仅覆盖 plan 工具路径），v4 投影的 config.mode 更新靠这条补发。
 */
export async function emitModeChanged(
  this: AgentRuntimeInternal,
  options: {
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceContext: TraceContext;
  },
): Promise<void> {
  const event = createSessionEvent(
    SessionEventType.SessionModeChanged,
    this.sessionId,
    {
      mode: this.getMode(),
      planEnabled: this.getPlanEnabled(),
      previousMode: options.previousMode,
      source: "command",
    },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}
