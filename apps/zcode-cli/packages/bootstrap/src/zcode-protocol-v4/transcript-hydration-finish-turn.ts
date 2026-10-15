// Modified by ZCode Feiyu.
import { SessionEventType, type TurnFileChangeSummary } from "@zcode/contracts";
import type {
  PushEvent,
  SynthesizeOptions,
  TurnResultForHydration,
} from "./transcript-hydration-subagent-tool-names.js";
import type { TurnOutputCollection } from "./transcript-hydration-assistant-message-has-synthesizable-content.js";

export interface HydratedTurnCompletion {
  modelSpeed?: TurnOutputCollection["modelSpeed"];
  failure?: TurnOutputCollection["failure"];
  fileChanges?: TurnFileChangeSummary;
  turnId: string;
  resultType: TurnResultForHydration;
  toolCallCount: number;
  historyRoundCount: number;
  turnStartedAtMs: number;
  turnEndedAtMs: number;
}

/** 冷恢复沿原事实 reducer 收口；此函数只合成事件，不持有会话状态。 */
export function finishHydratedTurn(
  input: HydratedTurnCompletion,
  options: { push: PushEvent; contextWindow: SynthesizeOptions["contextWindow"] },
): void {
  const { push, contextWindow } = options;
  if (input.failure) {
    // provider 首字前失败只持久化在 assistant.info.error，旧 cold 路径
    // 折成 TurnComplete(error_during_execution)，导致 lastError 的 code/message 全丢。
    // 这里复用 live 的 TurnError 状态机，避免另建 cold-only 错误 reducer。
    push(
      SessionEventType.TurnError,
      { error: input.failure, turnPhase: "model" },
      input.turnId,
      input.turnEndedAtMs,
    );
    return;
  }
  push(
    SessionEventType.ModelComplete,
    {
      content: "",
      stopReason: "end_turn",
      querySource: "main_turn",
      // 冷恢复曾把合成事件的窗口固定成 20 万，覆盖同一模型在
      // workspace provider registry 中的 1M 能力；这里沿用调用方解析出的当前模型真值。
      contextWindow,
      usage: {
        ...(input.modelSpeed ? { modelSpeed: input.modelSpeed } : {}),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      ...(input.fileChanges ? { fileChanges: input.fileChanges } : {}),
    },
    input.turnId,
    input.turnEndedAtMs,
  );
  push(
    SessionEventType.TurnComplete,
    {
      response: "",
      tokenCount: 0,
      toolCallCount: input.toolCallCount,
      historyRoundCount: input.historyRoundCount,
      // 冷恢复是从 message transcript 反向合成事件，不能像 live
      // 事件一样依赖运行时 startedAt；固定 0 会让历史轮次显示成 1 秒。
      duration: Math.max(0, input.turnEndedAtMs - input.turnStartedAtMs),
      resultType: input.resultType,
    },
    input.turnId,
    input.turnEndedAtMs,
  );
}
