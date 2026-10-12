// Modified by ZCode Feiyu.
import type {
  ApiRetryState,
  ConversationDelta,
  AssistantTextRow,
} from "@zcode/shared/zcode-protocol-v4";
import { positiveInteger } from "./product-projection-stream-recovery-reason-code.js";
import type { SessionEvent } from "@zcode/contracts";
import type { CanonicalAssistantSegmentFact } from "./event-normalizer.js";
import type { ProductProjection } from "./product-projection.js";

export function streamRecoveryApiRetry(
  this: ProductProjection,
  retryNumber: number,
  maxRetriesValue: number,
  nextRetryAt: number,
  reasonCode: string,
): ApiRetryState {
  const attempt = positiveInteger(retryNumber, 1);
  const maxRetries = Math.max(positiveInteger(maxRetriesValue, attempt), attempt);
  return {
    attempt,
    maxAttempts: maxRetries + 1,
    nextRetryAt,
    reasonCode,
  };
}

export function setApiRetry(
  this: ProductProjection,
  apiRetry: ApiRetryState | null,
): ConversationDelta[] {
  const current = this["snapshot"].control.apiRetry;
  if (
    current === apiRetry ||
    (current !== null &&
      apiRetry !== null &&
      current.attempt === apiRetry.attempt &&
      current.maxAttempts === apiRetry.maxAttempts &&
      current.nextRetryAt === apiRetry.nextRetryAt &&
      current.reasonCode === apiRetry.reasonCode)
  ) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: this["controlPatch"]({ apiRetry }),
    },
  ];
}

export function acceptsActiveModelEvent(this: ProductProjection, event: SessionEvent): boolean {
  if (!this["isRunning"]()) return false;
  // stop/新一轮后旧请求可能迟到；仅凭 session 级状态会让旧 turn 的
  // retry/progress 覆盖当前输入栏。当前 runtime turn 已知时必须按 turnId 隔离。
  return (
    this["currentTurnId"] === null ||
    event.turnId === undefined ||
    String(event.turnId) === this["currentTurnId"]
  );
}

export function onModelStreaming(
  this: ProductProjection,
  fact: CanonicalAssistantSegmentFact,
): ConversationDelta[] {
  const event = fact.event;
  // 迟到终态不复活：非运行期到达的流式事件一律拒收。
  // assistant 守恒：正文类拒收不是无害丢弃——投影建立晚于
  // TurnStarted（订阅中途建 publisher）时，整段回复会静默消失直到刷新
  // （「回复整段消失」的 live 向量）。计数暴露给 gateway：置 stale 标记，
  // 下次订阅强制重新 hydration 从持久事实补齐。
  if (!this["isRunning"]()) {
    const dropped = fact.stream;
    if (
      dropped.kind === "text_start" ||
      dropped.kind === "text_delta" ||
      dropped.kind === "reasoning_start" ||
      dropped.kind === "reasoning_delta"
    ) {
      this["droppedContentStreamEventCount"] += 1;
    }
    return [];
  }
  const payload = fact.stream;
  switch (payload.kind) {
    case "text_start":
      return this["openTextRow"](event, fact);
    case "text_delta": {
      const open = this["streamingTextRowId"] === null ? this["openTextRow"](event, fact) : [];
      return [
        ...open,
        {
          op: "row.delta",
          rowId: this["streamingTextRowId"] as number,
          path: "text",
          append: payload.delta,
        },
      ];
    }
    case "text_end":
      return this["closeTextRow"]("complete");
    case "reasoning_start":
      return this["openReasoningRow"](event, fact);
    case "reasoning_delta": {
      const open =
        this["streamingReasoningRowId"] === null ? this["openReasoningRow"](event, fact) : [];
      return [
        ...open,
        {
          op: "row.delta",
          rowId: this["streamingReasoningRowId"] as number,
          path: "text",
          append: payload.delta,
        },
      ];
    }
    case "reasoning_end":
      return this["closeReasoningRow"]();
    case "tool_input_start":
      return this["openToolRow"](event, payload, fact.entityId);
    case "tool_input_delta": {
      return this["appendStreamingToolInput"](event, payload);
    }
    case "tool_input_end":
      return this["flushStreamingToolInput"](String(payload.toolCallId ?? ""));
    case "tool_call":
      return this["finalizeStreamingToolInput"](event, payload);
    default:
      return [];
  }
}

export function openTextRow(
  this: ProductProjection,
  event: SessionEvent,
  fact: CanonicalAssistantSegmentFact,
): ConversationDelta[] {
  const close = this["closeTextRow"]("complete");
  const continuationRowId = this["outputContinuationTextRowId"];
  this["outputContinuationTextRowId"] = null;
  const continuationRow =
    continuationRowId === null ? undefined : this["findRow"](continuationRowId);
  const currentTurnId = this["turnIdOf"](event);
  const lastVisibleRow = this["snapshot"].rows.window.at(-1);
  if (
    continuationRow?.kind === "assistantText" &&
    continuationRow.turnId === currentTurnId &&
    lastVisibleRow?.rowId === continuationRow.rowId
  ) {
    // runtime 的 output-token Continue 会为每次 provider 请求创建新的
    // assistantMessageId；旧投影因此把一句话拆成 history partial + 轮尾正文。length
    // 已经在 ModelComplete 上提供精确资格，这里只重新打开紧邻的同 turn text row，
    // 让外部 continuous/replayable 客户端都只观察到一条持续增长的 assistant。
    const {
      actions: _actions,
      assistantResponseId: _assistantResponseId,
      feedback: _feedback,
      ...continuedBase
    } = continuationRow;
    const row: AssistantTextRow = {
      ...continuedBase,
      entityId: fact.entityId,
      ...(fact.stream.assistantResponseId
        ? { assistantResponseId: fact.stream.assistantResponseId }
        : {}),
      state: "streaming",
    };
    this["streamingTextRowId"] = row.rowId;
    this["entityIdByRowId"].set(row.rowId, fact.entityId);
    const previousMessageId = this["messageIdByRowId"].get(row.rowId);
    if (previousMessageId) {
      this["outputContinuationRowIdByMessageId"].set(previousMessageId, row.rowId);
    }
    if (fact.transcriptMessageId) {
      this["messageIdByRowId"].set(row.rowId, fact.transcriptMessageId);
    }
    return [...close, { op: "row.upserted", row }];
  }
  // 不变量：非 output-token Continue 的新段必然新 rowId；已有 streaming 行先收口。
  const row: AssistantTextRow = {
    ...this["rowBase"](event, this["turnIdOf"](event), fact.entityId),
    kind: "assistantText",
    ...(fact.stream.assistantResponseId
      ? { assistantResponseId: fact.stream.assistantResponseId }
      : {}),
    text: "",
    state: "streaming",
  };
  this["streamingTextRowId"] = row.rowId;
  this["entityIdByRowId"].set(row.rowId, fact.entityId);
  // forkAssistant 锚点：assistant 行 → 权威 messageId（provider 流首帧即带）。
  if (fact.transcriptMessageId) {
    this["messageIdByRowId"].set(row.rowId, fact.transcriptMessageId);
  }
  return [...close, { op: "row.appended", row }];
}

export function closeTextRow(
  this: ProductProjection,
  state: "complete" | "interrupted",
): ConversationDelta[] {
  if (this["streamingTextRowId"] === null) return [];
  const row = this["findRow"](this["streamingTextRowId"]);
  this["streamingTextRowId"] = null;
  if (row?.kind !== "assistantText") return [];
  return [{ op: "row.upserted", row: { ...row, state } }];
}
