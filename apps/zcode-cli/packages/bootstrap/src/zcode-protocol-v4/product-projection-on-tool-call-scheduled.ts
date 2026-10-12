// Modified by ZCode Feiyu.
import type {
  SessionEvent,
  ToolCallScheduledPayload,
  ToolCallStartedPayload,
  ToolCallProgressPayload,
  ToolCallResultPayload,
} from "@zcode/contracts";
import type { ConversationDelta, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";
import {
  stringifyToolInput,
  toProtocolToolCallDisplay,
} from "./product-projection-stream-recovery-reason-code.js";
import {
  readOfficialCuaAction,
  resolveCuaAppIdentity,
  parseListAppsSnapshot,
} from "./cua-app-snapshot.js";
import { extractPlanStepsFromToolInput, extractPlanStepsFromToolOutput } from "@zcode/shared";
import { projectToolActivity } from "./product-projection-bash-progress.js";
import { buildToolOutput } from "./projection-rows.js";
import type { ProductProjection } from "./product-projection.js";

export function onToolCallScheduled(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  if (this["isMirroredSubagentToolEvent"](event) || !this["isRunning"]()) return [];
  const payload = event.payload as ToolCallScheduledPayload;
  const toolCallId = String(payload.toolCallId);
  this["fileToolInputPreviewByCallId"].delete(toolCallId);
  if (shouldHideInvalidToolCallFromProduct(payload.toolName)) return [];
  const inputText = stringifyToolInput(payload.input);
  const cuaAction = readOfficialCuaAction(payload.toolName);
  const cuaApp =
    cuaAction && cuaAction !== "list_apps"
      ? resolveCuaAppIdentity(payload.input, this["latestListAppsSnapshot"])
      : undefined;
  const existing = this["findToolRow"](toolCallId);
  const planDeltas = this["todoPlanDeltas"](
    event,
    extractPlanStepsFromToolInput({
      title: payload.toolName,
      kind: payload.toolName,
      input: payload.input,
    }),
  );
  if (existing) {
    // replayable 会过滤 row.delta(inputText)，定稿 upsert 必须携带完整 inputText。
    // 否则断线恢复只能看到结构化 input，丢失 v4 row 的输入文本终态。
    return [
      {
        op: "row.upserted",
        row: {
          ...existing,
          ...(payload.assistantMessageId
            ? { assistantResponseId: String(payload.assistantMessageId) }
            : {}),
          inputText,
          input: payload.input,
          ...(cuaApp ? { cuaApp } : {}),
          ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
        },
      },
      ...planDeltas,
    ];
  }
  const row: ToolCallRow = {
    ...this["rowBase"](event, this["turnIdOf"](event), toolCallId),
    kind: "toolCall",
    ...(payload.assistantMessageId
      ? { assistantResponseId: String(payload.assistantMessageId) }
      : {}),
    toolCallId,
    toolName: payload.toolName,
    status: "inputStreaming",
    inputText,
    input: payload.input,
    ...(cuaApp ? { cuaApp } : {}),
    ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
  };
  this["toolRowIdByCallId"].set(toolCallId, row.rowId);
  return [{ op: "row.appended", row }, ...planDeltas];
}

export function onToolCallActivity(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  if (this["isMirroredSubagentToolEvent"](event) || !this["isRunning"]()) return [];
  const payload = event.payload as ToolCallStartedPayload;
  this["recordHighspeedToolStarted"](
    this["turnIdOf"](event),
    String(payload.toolCallId),
    this["ms"](event),
  );
  const row = this["findToolRow"](String(payload.toolCallId));
  if (!row) return [];
  return projectToolActivity(event, row);
}

export function onToolCallProgress(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  if (this["isMirroredSubagentToolEvent"](event) || !this["isRunning"]()) return [];
  const payload = event.payload as ToolCallProgressPayload;
  const row = this["findToolRow"](String(payload.toolCallId));
  if (!row || row.status !== "running") return [];
  // 两个分支共用 ToolCallProgress：Bash 尾窗与 MCP 百分比必须分别投影，避免合并后互相覆盖。
  if (row.toolName === "Bash") return projectToolActivity(event, row);
  const total =
    typeof payload.total === "number" && Number.isFinite(payload.total) && payload.total > 0
      ? payload.total
      : undefined;
  const fraction =
    total !== undefined && typeof payload.progress === "number" && Number.isFinite(payload.progress)
      ? Math.min(1, Math.max(0, payload.progress / total))
      : undefined;
  const message =
    typeof payload.message === "string" && payload.message.trim().length > 0
      ? payload.message.trim().slice(0, 200)
      : undefined;
  if (fraction === undefined && message === undefined && total === undefined) return [];
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        progress: {
          ...(fraction !== undefined ? { fraction } : {}),
          ...(total !== undefined ? { total } : {}),
          ...(message !== undefined ? { message } : {}),
          updatedAt: this["ms"](event),
        },
      },
    },
  ];
}

export function onToolCallResult(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  if (this["isMirroredSubagentToolEvent"](event) || !this["isRunning"]()) return [];
  const payload = event.payload as ToolCallResultPayload;
  const toolCallId = String(payload.toolCallId);
  this["recordHighspeedToolEnded"](
    this["turnIdOf"](event),
    toolCallId,
    this["ms"](event),
    payload.duration,
  );
  const row = this["findToolRow"](toolCallId);
  if (!row) return [];
  const success = payload.result.success;
  if (success && readOfficialCuaAction(row.toolName) === "list_apps") {
    // 摘要身份必须来自 Agent 已观察到的成功事实；失败结果不能清空旧快照。
    const snapshot = parseListAppsSnapshot(payload.result.content, payload.result.display);
    if (snapshot) this["latestListAppsSnapshot"] = snapshot;
  }
  const display = toProtocolToolCallDisplay(payload.result.display);
  const next: ToolCallRow = {
    ...row,
    status: success ? "success" : "error",
    // 终态清除运行中进度（R7）。
    progress: undefined,
    output: buildToolOutput(payload.result, toolCallId),
    ...(display ? { display } : {}),
    endedAt: this["ms"](event),
  };
  if (!success) {
    next.error = {
      code: payload.result.error?.type ?? "fault.runtime.toolFailed",
      message: payload.result.error?.message ?? "Tool execution failed.",
    };
  }
  const planDeltas = success
    ? this["todoPlanDeltas"](
        event,
        extractPlanStepsFromToolOutput({
          title: row.toolName,
          kind: row.toolName,
          output: payload.result.content,
        }),
      )
    : [];
  return [{ op: "row.upserted", row: next }, ...planDeltas];
}
