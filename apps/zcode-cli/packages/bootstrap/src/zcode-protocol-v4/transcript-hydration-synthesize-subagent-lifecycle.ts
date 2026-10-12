// Modified by ZCode Feiyu.
import type {
  ParsedSubagentOutput,
  PushEvent,
  AssistantSynthesisState,
} from "./transcript-hydration-subagent-tool-names.js";
import { SessionEventType, parseCompletedToolPartMetadata } from "@zcode/contracts";
import type { MessagePart } from "@zcode/contracts";
import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";
import {
  stableToolSchedule,
  compactEventType,
} from "./transcript-hydration-subagent-tool-names.js";
import {
  subagentInfoFromToolPart,
  subagentStatusFromToolPart,
} from "./transcript-hydration-subagent-info-from-tool-part.js";
import {
  compactPayloadFromTimelinePart,
  compactPayloadFromLegacyCompactionPart,
} from "./transcript-hydration-normalize-compact-timeline-status.js";

export function synthesizeSubagentLifecycle(
  info: ParsedSubagentOutput,
  status: "completed" | "failed" | "cancelled",
  push: PushEvent,
  turnId: string,
): void {
  const agentId = info.agentId ?? `subagent-${turnId}`;
  push(
    SessionEventType.SubagentSpawned,
    {
      agentId,
      agentType: info.agentType ?? "subagent",
      childSessionId: info.childSessionId,
      description: info.description ?? info.summaryText ?? info.prompt ?? agentId,
      parentToolCallId: info.parentToolCallId,
      prompt: info.prompt,
      status: "running",
    },
    turnId,
  );
  push(
    SessionEventType.SubagentStopped,
    {
      agentId,
      agentType: info.agentType ?? "subagent",
      childSessionId: info.childSessionId,
      description: info.description,
      parentToolCallId: info.parentToolCallId,
      prompt: info.prompt,
      summaryText: info.summaryText,
      status,
    },
    turnId,
  );
}

export function synthesizeToolPart(
  part: Extract<MessagePart, { type: "tool" }>,
  assistantMessageId: string,
  push: PushEvent,
  turnId: string,
): AssistantSynthesisState {
  if (shouldHideInvalidToolCallFromProduct(part.tool, part.metadata)) {
    // footprint 过滤只决定是否需要补事件，不能阻止实际合成；这里必须在事件源头
    // 跳过带原始空名 metadata 的恢复 part，避免 cold hydration 重新物化工具行。
    return { resultType: "success", toolCallCount: 0 };
  }
  const toolCallId = part.callID;
  const persistedMetadata = parseCompletedToolPartMetadata(
    "metadata" in part.state ? part.state.metadata : part.metadata,
  );
  push(
    SessionEventType.ToolCallScheduled,
    {
      toolCallId,
      assistantMessageId,
      toolName: part.tool,
      input: part.state.input,
      ...(persistedMetadata?.display ? { display: persistedMetadata.display } : {}),
      schedule: stableToolSchedule(toolCallId),
    },
    turnId,
  );

  const started =
    part.state.status === "running" ||
    part.state.status === "completed" ||
    part.state.status === "error";
  if (started) {
    push(
      SessionEventType.ToolCallStarted,
      {
        toolCallId,
        toolName: part.tool,
        ...(persistedMetadata?.display ? { display: persistedMetadata.display } : {}),
        startedAt: new Date(
          "time" in part.state && typeof part.state.time.start === "number"
            ? part.state.time.start
            : 0,
        ),
      },
      turnId,
    );
  }

  // （2026-09-12）：历史 transcript 里残留的 metadata.widgetState 不再合成事件，
  // 冷恢复直接忽略（widgetState 只留 renderer 内存）。

  const subagentInfo = subagentInfoFromToolPart(part);
  if (subagentInfo && started) {
    synthesizeSubagentLifecycle(subagentInfo, subagentStatusFromToolPart(part), push, turnId);
  }

  if (part.state.status === "completed") {
    push(
      SessionEventType.ToolCallResult,
      {
        toolCallId,
        duration: Math.max(0, part.state.time.end - part.state.time.start),
        result: {
          success: true,
          content: part.state.output,
          ...(persistedMetadata?.display ? { display: persistedMetadata.display } : {}),
        },
      },
      turnId,
    );
    return { resultType: "success", toolCallCount: 1 };
  }

  if (part.state.status === "error") {
    push(
      SessionEventType.ToolCallResult,
      {
        toolCallId,
        duration: Math.max(0, part.state.time.end - part.state.time.start),
        result: {
          success: false,
          content: part.state.error,
          error: {
            type: "fault.runtime.toolFailed",
            message: part.state.error,
          },
        },
      },
      turnId,
    );
    return { resultType: "success", toolCallCount: 1 };
  }

  // CLI 重启后无法证明历史 pending/running 工具仍在运行，不能把
  // active work / stop 按钮复活；让 TurnComplete(cancelled) 统一收口成只读历史。
  return { resultType: "cancelled", toolCallCount: 1 };
}

export function synthesizeCompactPart(
  part: MessagePart,
  emittedCompactOperations: Set<string>,
  durableCompactPartsByOperation: ReadonlyMap<string, Extract<MessagePart, { type: "compaction" }>>,
  push: PushEvent,
  turnId: string,
): boolean {
  let compact =
    part.type === "timeline"
      ? compactPayloadFromTimelinePart(part)
      : part.type === "compaction"
        ? compactPayloadFromLegacyCompactionPart(part)
        : null;
  if (!compact) return false;
  const operationId = String(compact.payload.operationId);
  const durablePart = durableCompactPartsByOperation.get(operationId);
  if (durablePart) {
    // 同 operation 的 timeline part 通常排在 durable compaction part 前面。
    // 旧“先到先得”会丢 tail_start_id；优先采用带 coverage boundary 的 durable payload。
    const durablePayload = compactPayloadFromLegacyCompactionPart(durablePart);
    compact = durablePayload ?? {
      ...compact,
      payload: {
        ...compact.payload,
        ...(durablePart.tail_start_id ? { tailStartMessageId: durablePart.tail_start_id } : {}),
        ...(durablePart.boundaryId ? { boundaryId: durablePart.boundaryId } : {}),
        ...(durablePart.summaryMessageId ? { summaryMessageId: durablePart.summaryMessageId } : {}),
      },
    };
  }
  if (emittedCompactOperations.has(operationId)) return true;
  emittedCompactOperations.add(operationId);
  push(compactEventType(compact.status), compact.payload, turnId);
  return true;
}

// ── goal verification timeline part──
// 持久化契约（core events.ts persistDurableSessionEvent）：verifier 每次生命周期变化
// upsert 同一个 timeline part，身份 targetId_goalIteration，status 为最终生命周期态。
// 反向合成为 started(+终态) 事件对，复用投影既有 goalVerify marker 状态机。
// 旧 hydration 只认 context_compaction，goal_verification part 落入无人
// 消费的分支——每次冷恢复 goalVerify marker 都消失。
export function goalVerificationKeyOfPart(
  part: Extract<MessagePart, { type: "timeline" }>,
): string {
  if (part.timelineType !== "goal_verification") return String(part.id);
  return part.goalIteration !== undefined
    ? `${part.targetId}_${part.goalIteration}`
    : part.verificationId;
}

// 冷恢复无法证明历史 verifier 仍在运行（同 pending tool 收口为 cancelled 的先例）：
// started/未知态收口为 cancelled；completed/failed_closed 原样还原。
export function goalVerificationTerminalStatus(
  status: string | undefined,
): "completed" | "failed_closed" | "cancelled" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "failed_closed":
      return "failed_closed";
    default:
      return "cancelled";
  }
}

/** goal verify 事实的归一形态：timeline part（新契约）与 session_entry（legacy 主体）共用。 */
export interface GoalVerificationFact {
  key: string;
  targetId: string;
  verificationId: string;
  goalIteration?: number;
  anchorAssistantMessageId?: string;
  anchorTurnId?: string;
  status?: string;
  verification?: unknown;
}
