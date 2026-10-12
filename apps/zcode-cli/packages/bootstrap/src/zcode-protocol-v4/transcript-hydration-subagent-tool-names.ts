// Modified by ZCode Feiyu.
import {
  CoreErrorType,
  ModelErrorCode,
  SessionEventType,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
  CompactTimelineStatus,
} from "@zcode/contracts";
import type {
  TurnFileChangeSummary,
  MessageWithParts,
  MessagePart,
  AssistantErrorInfo,
  CompactTimelineStatus as CompactTimelineStatusValue,
} from "@zcode/contracts";
import {
  isConversationRealUserTurnStarter,
  getConversationMessageProjectionPolicy,
} from "@zcode/shared";
import type { WorkflowLaunchMeta, ErrorAttribution } from "@zcode/shared/zcode-protocol-v4";
import { workflowLaunchMetaSchema, errorAttributionSchema } from "@zcode/shared/zcode-protocol-v4";

export const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);

export const LEGACY_MODEL_REQUEST_CANCELLED_MESSAGE = "Model request was cancelled.";

export const LEGACY_PROTOCOL_SESSION_STOPPED_MESSAGE = "ZCode Protocol session stopped";

export const PERSISTED_CANCELLATION_CODES = new Set<string>([
  CoreErrorType.TurnCancelled,
  ModelErrorCode.ModelRequestCancelled,
  "MODEL_REQUEST_CANCELLED",
  "ABORT_ERR",
]);

export type PushEvent = (
  type: SessionEventType,
  payload: unknown,
  turnId?: string,
  sourceTimestampMs?: number,
) => void;

export type TurnResultForHydration = "success" | "cancelled" | "error_during_execution";

export interface AssistantSynthesisState {
  toolCallCount: number;
  resultType: TurnResultForHydration;
}

export interface TranscriptFootprint {
  userTurnCount: number;
  assistantTexts: string[];
  reasoningTexts: string[];
  toolCallIds: string[];
  compactMarkerCount: number;
  subagentCount: number;
  forkTimelineCount: number;
  // 16-timeline-authority-plan P1：守恒判据曾对 goal verify / model change 全盲
  //（footprint 不计数 → 缺这两类 marker 的事件日志被误判为已覆盖）。
  goalVerificationCount: number;
  modelChangeCount: number;
}

export interface ParsedSubagentOutput {
  agentId?: string;
  agentType?: string;
  childSessionId?: string;
  description?: string;
  parentToolCallId?: string;
  prompt?: string;
  summaryText?: string;
}

// ── session_entry legacy 源──
// 历史上 goal verify 主要持久化在 session_entry（本机观测 1,402 行 vs timeline part
// 仅 10 行）；entry.data 保留了原始事件 payload。读取端跨源按 targetId_goalIteration
// 去重：timeline part 与 entry 表达同一事实时只发一次（先到先得，anchor 语义一致）。
export interface HydratedGoalVerificationEntry {
  payload: {
    targetId: string;
    status?: string;
    verificationId: string;
    verification?: unknown;
    goalIteration?: number;
    anchorAssistantMessageId?: string;
    anchorTurnId?: string;
  };
  sequenceNumber?: number;
  timeCreated: number;
}

export interface SynthesizeOptions {
  sessionId: string;
  /**
   * 当前 session 实际选中模型的权威上下文窗口。
   * transcript 只持久化 token 用量，不持久化模型能力，必须由当前 workspace registry 注入。
   */
  contextWindow?: number;
  /** 合成基准时间戳（确定性：不用 Date.now，由调用方传入首条消息时间兜底）。 */
  baseTimestampMs?: number;
  /**
   * session_entry legacy 源的 goal verify 事实：
   * 有 anchor 的按 anchorAssistantMessageId 落到对应 assistant 之后，
   * 无 anchor/anchor 失配的落到已知时间线末尾；与 timeline part 按 key 去重。
   */
  goalVerificationEntries?: readonly HydratedGoalVerificationEntry[];
  /**
   * workspace checkpoint artifact 按真实 user messageId 重建出的单轮摘要。
   * transcript 没有该字段，必须显式注入合成 ModelComplete 才能保持 live/cold 等价。
   */
  fileChangeSummariesByMessageId?: ReadonlyMap<string, TurnFileChangeSummary>;
}

export function isRealUserTurnStarter(message: MessageWithParts): boolean {
  return isConversationRealUserTurnStarter(message);
}

/**
 * 中枢直接启动工作流的启动轮消息。核心持久化时写
 * `source: "workflow_launch"` + `metadata.workflowLaunch`（冷恢复的权威来源）。它是 synthetic
 * 但语义上属于用户真实动作的可见消息，共享投影 policy 会把 synthetic user 归成 hiddenSynthetic，
 * 因此 `isConversationRealUserTurnStarter` 认不出它；冷路径据本判据在 real-user 分支之前显式重建
 * 与活投影同形的 controlOnly 启动轮（TurnStarted{inputSource, workflowLaunch, executionKind} +
 * TurnComplete），而不是被当作隐藏 synthetic 跳过。畸形 / 缺席元数据回 null（退回既有跳过语义）。
 */
export function workflowLaunchOfMessage(message: MessageWithParts): WorkflowLaunchMeta | null {
  if (message.info.role !== "user") return null;
  if (message.info.source !== "workflow_launch") return null;
  const metadata = message.info.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const parsed = workflowLaunchMetaSchema.safeParse(
    (metadata as Record<string, unknown>).workflowLaunch,
  );
  return parsed.success ? parsed.data : null;
}

export function isProviderContextOnlyAssistant(message: MessageWithParts): boolean {
  return (
    message.info.role === "assistant" &&
    getConversationMessageProjectionPolicy(message) === "providerContextOnly"
  );
}

export function textOfMessage(parts: readonly MessagePart[]): string {
  return parts
    .filter(
      (part): part is Extract<MessagePart, { type: "text" }> =>
        part.type === "text" && part.ignored !== true,
    )
    .map((part) => part.text)
    .join("");
}

export function finiteTimeMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function messageCreatedAtMs(message: MessageWithParts): number | undefined {
  return finiteTimeMs(message.info.time.created);
}

export function intervalEndOrStartMs(time: { start: number } & Partial<{ end: number }>) {
  return finiteTimeMs(time.end) ?? finiteTimeMs(time.start);
}

export function partEndAtMs(part: MessagePart): number | undefined {
  if (part.type === "reasoning") {
    return finiteTimeMs(part.time?.end) ?? finiteTimeMs(part.time?.start);
  }
  if (part.type === "tool" && "time" in part.state) {
    return intervalEndOrStartMs(part.state.time);
  }
  return undefined;
}

export function messageEndAtMs(message: MessageWithParts): number | undefined {
  const time = message.info.time;
  // 冷恢复会同时处理 user/assistant message；user 只有 created，
  // assistant 才可能有 completed，所以这里必须按字段存在性收窄后再取结束时间。
  let end =
    ("completed" in time ? finiteTimeMs(time.completed) : undefined) ?? finiteTimeMs(time.created);
  for (const part of message.parts) {
    const partEnd = partEndAtMs(part);
    if (partEnd !== undefined) {
      end = end === undefined ? partEnd : Math.max(end, partEnd);
    }
  }
  return end;
}

export function normalizeTurnResult(
  current: TurnResultForHydration,
  next: TurnResultForHydration,
): TurnResultForHydration {
  if (current === "cancelled" || next === "cancelled") {
    return "cancelled";
  }
  if (current === "error_during_execution" || next === "error_during_execution") {
    return "error_during_execution";
  }
  return "success";
}

export function assistantErrorData(error: AssistantErrorInfo): Record<string, unknown> | undefined {
  return error.data && typeof error.data === "object" && !Array.isArray(error.data)
    ? error.data
    : undefined;
}

export function persistedErrorAttribution(
  data: Record<string, unknown> | undefined,
): ErrorAttribution | undefined {
  const parsed = errorAttributionSchema.safeParse(data?.attribution);
  return parsed.success ? parsed.data : undefined;
}

export function isPersistedAssistantCancellation(error: AssistantErrorInfo): boolean {
  const data = assistantErrorData(error);
  const code = typeof data?.code === "string" ? data.code : undefined;
  if (
    data?.turnResult === "cancelled" ||
    data?.resultType === "cancelled" ||
    (code !== undefined && PERSISTED_CANCELLATION_CODES.has(code)) ||
    error.name === "AbortError"
  ) {
    return true;
  }

  if (
    code === undefined &&
    error.name === "Error" &&
    data?.message === LEGACY_PROTOCOL_SESSION_STOPPED_MESSAGE
  ) {
    // 旧 session/stop 使用普通 Error 作为 AbortSignal.reason，transcript 又未持久化
    // cancelled result；冷恢复若只认 AbortError，会把用户停止重新合成为 TurnError 和错误 Banner。
    return true;
  }

  // 旧 transcript 的 AiSdkModelAdapterError 没有持久化 model error code，
  // 只能用 ZCode 自身生成的标准 name/message 二元组兼容恢复；不泛化匹配 provider 文案。
  return (
    code === undefined &&
    error.name === "AiSdkModelAdapterError" &&
    data?.message === LEGACY_MODEL_REQUEST_CANCELLED_MESSAGE
  );
}

/**
 * stream recovery 把作废的半截 assistant 持久化成带 error 的消息，随后从锚点
 * 重发并正常完成；live 投影只把它收口为 interrupted 行，不产生 TurnError。旧冷恢复却把
 * 任何带 error 的 assistant 都当本轮失败，重开会话后凭空弹出「Partial assistant output
 * was discarded」的错误 Banner。这个标记只服务压缩/fork 边界隔离，对本轮结果必须透明。
 */
export function isPersistedStreamRecoveryDiscard(error: AssistantErrorInfo): boolean {
  return error.name === STREAM_RECOVERY_DISCARDED_ERROR_NAME;
}

export function stableToolSchedule(toolCallId: string) {
  return {
    executionOrder: [toolCallId],
    parallelGroups: [[toolCallId]],
  };
}

export function compactEventType(status: CompactTimelineStatusValue): SessionEventType {
  if (status === CompactTimelineStatus.Started || status === CompactTimelineStatus.Retrying) {
    return SessionEventType.CompactStarted;
  }
  if (status === CompactTimelineStatus.Completed || status === CompactTimelineStatus.Skipped) {
    return SessionEventType.CompactCompleted;
  }
  return SessionEventType.CompactFailed;
}
