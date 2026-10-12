// Modified by ZCode Feiyu.
import type {
  SessionEvent,
  AssistantFeedbackUpdatedPayload,
  HighspeedMetricsUpdatedPayload,
  TurnExecutionModelFallbackPayload,
} from "@zcode/contracts";
import type {
  ConversationDelta,
  AssistantTextRow,
  UserInputRow,
  ReasoningRow,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { CanonicalAssistantSegmentFact } from "./event-normalizer.js";
import type { ProductProjection } from "./product-projection.js";

export function onAssistantFeedbackUpdated(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as AssistantFeedbackUpdatedPayload;
  const row = this["snapshot"].rows.window.find(
    (candidate): candidate is AssistantTextRow =>
      candidate.kind === "assistantText" && candidate.entityId === payload.entityId,
  );
  if (!row) return [];
  if (payload.feedback === null) {
    if (row.feedback === undefined) return [];
    const { feedback: _removedFeedback, ...withoutFeedback } = row;
    return [{ op: "row.upserted", row: withoutFeedback }];
  }
  if (row.feedback === payload.feedback) return [];
  return [{ op: "row.upserted", row: { ...row, feedback: payload.feedback } }];
}

export function onHighspeedMetricsUpdated(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as HighspeedMetricsUpdatedPayload;
  const row = this["snapshot"].rows.window.find(
    (candidate): candidate is UserInputRow =>
      candidate.kind === "userInput" && candidate.entityId === payload.entityId,
  );
  if (!row) return [];
  // Bug 根因：终态指标更新曾整体替换 row.highspeed。payload 来自 transcript 原始 metadata + 耗时字段，
  // 不含 live 投影刚由 TurnExecutionModelFallback 写入的 fallbackAt；降级 Toast 依赖的字段被清空，
  // live 与 cold/replay 的结果也不一致。指标更新是增量补充：字段级合并、只增不删（spec §5）。
  return [
    {
      op: "row.upserted",
      row: { ...row, highspeed: { ...row.highspeed, ...payload.highspeed } },
    },
  ];
}

export function onTurnExecutionModelFallback(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnExecutionModelFallbackPayload;
  // Bug 根因：fallback 会作废当前 assistant attempt，但旧投影只更新输入行元数据，仍把旧模型的
  // text/reasoning row 留在 streaming；原模型续流时这些内容会被误标 complete，缺少 text_start 时
  // 甚至直接拼到同一行。未定稿的 tool input 同样不会收到 tool_call，必须随废弃 attempt 一起收口。
  // 已提交执行的工具不在这里处理，它们由 core 的 tool_abandoned 事件收口。
  const discardedStreamDeltas = this["acceptsActiveModelEvent"](event)
    ? [
        ...this["closeStreamingRows"]("interrupted"),
        ...this["closeOpenToolRows"](event, "cancelled", (row) => row.status === "inputStreaming"),
      ]
    : [];
  // 卡过期与其他加速请求失败都投影到同一张加速输入行：fallbackAt 触发一次性提示，
  // fallbackReason 让 Renderer 区分“卡已到期”与“加速服务不可用”两种文案。
  const turnId = this["turnIdOf"](event);
  const row = this["snapshot"].rows.window.find(
    (candidate): candidate is UserInputRow =>
      candidate.kind === "userInput" &&
      // Bug 根因：cold hydration 会重建 product turnId，不能再拿 runtime turnId
      // 关联已持久化的输入；inputId/sourceCommandId 才是跨恢复稳定身份。
      (candidate.turnId === turnId ||
        (payload.inputId !== undefined && candidate.sourceCommandId === payload.inputId)) &&
      candidate.highspeed !== undefined,
  );
  if (!row?.highspeed) return discardedStreamDeltas;
  return [
    ...discardedStreamDeltas,
    {
      op: "row.upserted",
      row: {
        ...row,
        highspeed: {
          ...row.highspeed,
          fallbackAt: event.timestamp.getTime(),
          fallbackReason: payload.reason,
        },
      },
    },
  ];
}

export function openReasoningRow(
  this: ProductProjection,
  event: SessionEvent,
  fact: CanonicalAssistantSegmentFact,
): ConversationDelta[] {
  const close = this["closeReasoningRow"]();
  const row: ReasoningRow = {
    ...this["rowBase"](event, this["turnIdOf"](event), fact.entityId),
    kind: "reasoning",
    // Bug 原因：canonical stream 已携带 assistant response 身份，但旧投影只在正文与工具行
    // 保存它，UI 因而无法把同 response 的 reasoning 确定性归入 CUA Group。
    ...(fact.stream.assistantResponseId
      ? { assistantResponseId: fact.stream.assistantResponseId }
      : {}),
    text: "",
    state: "streaming",
  };
  this["streamingReasoningRowId"] = row.rowId;
  this["entityIdByRowId"].set(row.rowId, fact.entityId);
  return [...close, { op: "row.appended", row }];
}

export function closeReasoningRow(
  this: ProductProjection,
  state: "complete" | "interrupted" = "complete",
): ConversationDelta[] {
  if (this["streamingReasoningRowId"] === null) return [];
  const row = this["findRow"](this["streamingReasoningRowId"]);
  this["streamingReasoningRowId"] = null;
  if (row?.kind !== "reasoning") return [];
  return [{ op: "row.upserted", row: { ...row, state } }];
}

export function closeStreamingRows(
  this: ProductProjection,
  state: "complete" | "interrupted",
): ConversationDelta[] {
  return [...this["closeTextRow"](state), ...this["closeReasoningRow"](state)];
}

export function closeOpenToolRows(
  this: ProductProjection,
  event: SessionEvent,
  status: "cancelled" | "error",
  only?: (row: ToolCallRow) => boolean,
): ConversationDelta[] {
  if (this["openForegroundToolCallIds"].size === 0) return [];
  const openRows: ToolCallRow[] = [];
  for (const toolCallId of this["openForegroundToolCallIds"]) {
    const row = this["findToolRow"](toolCallId);
    // 派生索引不能成为第二份权威状态；收口前始终以当前 snapshot row 复核。
    if (!row || !this["isOpenForegroundToolRow"](row)) continue;
    if (only && !only(row)) continue;
    openRows.push(row);
  }
  if (openRows.length === 0) return [];
  // Set 可能因迟到 reopen 改变插入顺序；rowId 单调递增，排序后保持旧 timeline delta 顺序。
  if (openRows.length > 1) {
    openRows.sort((left, right) => left.rowId - right.rowId);
  }
  const deltas: ConversationDelta[] = [];
  const closedToolCallIds = new Set<string>();
  for (const row of openRows) {
    const next: ToolCallRow = {
      ...row,
      status,
      inputText: `${row.inputText ?? ""}${this["takePendingStreamingToolInput"](row.toolCallId)}`,
      endedAt: this["ms"](event),
    };
    delete next.approvalInteractionId;
    if (status === "error") {
      // executor 早退或事件缺失时，旧投影只在 stop 路径收口工具；
      // success/error turn 会留下运行态行，cold snapshot 缺 header 后被 UI 误判为 thinking。
      next.error = {
        code: "fault.runtime.toolLifecycleIncomplete",
        message: "Tool call ended without a terminal event.",
      };
    } else {
      delete next.error;
    }
    closedToolCallIds.add(row.toolCallId);
    deltas.push({ op: "row.upserted", row: next });
  }
  const pendingInteractions = this["snapshot"].pendingInteractions.filter(
    (interaction) =>
      !(
        (interaction.payload.kind === "permission" || interaction.payload.kind === "userInput") &&
        typeof interaction.payload.toolCallId === "string" &&
        closedToolCallIds.has(interaction.payload.toolCallId)
      ),
  );
  if (pendingInteractions.length !== this["snapshot"].pendingInteractions.length) {
    deltas.push({ op: "state.updated", patch: { pendingInteractions } });
  }
  return deltas;
}

export function isOpenForegroundToolRow(this: ProductProjection, row: ToolCallRow): boolean {
  return (
    row.backgrounded !== true &&
    (row.status === "inputStreaming" ||
      row.status === "pendingApproval" ||
      row.status === "running")
  );
}
