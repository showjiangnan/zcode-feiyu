// Modified by ZCode Feiyu.
import type { HydratedGoalVerificationEntry } from "./transcript-hydration.js";
import type {
  SessionEvent,
  MessageWithParts,
  SessionGoal,
  SessionEntryInfo,
  TurnFileChangeSummary,
} from "@zcode/contracts";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { selectActiveConversationBranch, SessionEventType } from "@zcode/contracts";
import { goalVerificationEntriesFromSessionEntries } from "./transcript-hydration.js";

export interface ConversationMaterializationSource {
  goalVerificationEntries: HydratedGoalVerificationEntry[];
  memoryEvents: SessionEvent[];
  messages: MessageWithParts[];
  /** shared_context 正文仍是 provider-only；这里只下发脱敏的 handover metadata。 */
  sharedContextImport?: ConversationSnapshot["sharedContextImport"];
  /** 只有成功读取 session_target 后才存在；显式 null 也是持久 authority。 */
  target?: SessionGoal | null;
}

export interface PersistedConversationMaterializationStore {
  getSession(sessionId: import("@zcode/contracts").SessionId): Promise<{
    title?: string;
    revert?: {
      branchCutAfterMessageID?: import("@zcode/contracts").MessageId;
      branchGeneration?: number;
      createdMessageID?: import("@zcode/contracts").MessageId;
      keptMessageIDs?: import("@zcode/contracts").MessageId[];
      targetMessageID?: import("@zcode/contracts").MessageId;
    };
  } | null>;
  messages(input: { sessionID: import("@zcode/contracts").SessionId }): Promise<MessageWithParts[]>;
  readTarget(input: {
    sessionID: import("@zcode/contracts").SessionId;
  }): Promise<SessionGoal | null>;
  sessionEntries?(input: {
    sessionID: import("@zcode/contracts").SessionId;
    type?: string;
  }): Promise<SessionEntryInfo[]>;
}

/**
 * cold materialization 的单一持久事实入口。
 *
 * 旧 bridge 只读取全量 message/part，既没有读取 session.revert 来裁掉
 * 已回滚分支，也没有读取 session_target；结果 runtime resume / stable fork 已经使用
 * active branch，而刷新 projection 却会复活旧分支并把 goal 恢复成 null。
 */
export async function loadPersistedConversationMaterialization(input: {
  memoryEvents: readonly SessionEvent[];
  persistedMessages?: MessageWithParts[];
  sessionId: string;
  store?: PersistedConversationMaterializationStore;
}): Promise<ConversationMaterializationSource> {
  if (!input.store) {
    // 无 sessionStore 时旧 bridge 人工填 target:null，把“没有读取”误当成
    // “持久层明确清空”，进而压掉唯一的内存 TargetChanged 并强制 synthesized。
    return {
      goalVerificationEntries: [],
      memoryEvents: [...input.memoryEvents],
      messages: [],
    };
  }
  const sessionID = input.sessionId as import("@zcode/contracts").SessionId;
  const [session, allMessages, target, entries] = await Promise.all([
    input.store.getSession(sessionID),
    input.persistedMessages ?? input.store.messages({ sessionID }),
    input.store.readTarget({ sessionID }),
    input.store.sessionEntries ? input.store.sessionEntries({ sessionID }) : Promise.resolve([]),
  ]);
  const messages = selectActiveConversationBranch(allMessages, {
    branchCutAfterMessageId: session?.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session?.revert?.createdMessageID,
    rewindKeptMessageIds: session?.revert?.keptMessageIDs,
    rewindTargetMessageId: session?.revert?.targetMessageID,
  });
  const sharedContextMessage = messages.find(
    (message) =>
      message.info.role === "user" &&
      message.info.source === "shared_context" &&
      message.info.semantics?.origin === "import" &&
      message.info.semantics?.kind === "shared_context",
  );
  const sharedContextEntry = entries.find((entry) => entry.type === "v4/shared_context_import");
  const sharedContextData =
    sharedContextEntry?.data && typeof sharedContextEntry.data === "object"
      ? (sharedContextEntry.data as Record<string, unknown>)
      : undefined;
  const contextId =
    typeof sharedContextData?.contextId === "string" ? sharedContextData.contextId : undefined;
  const shareUrl =
    typeof sharedContextData?.shareUrl === "string" ? sharedContextData.shareUrl : undefined;
  const status = sharedContextData?.status;
  const sharedContextImport =
    sharedContextMessage && session?.title?.trim()
      ? contextId &&
        shareUrl &&
        ["pending", "reserved", "attached", "discarded"].includes(String(status))
        ? {
            contextId,
            title: session.title.trim(),
            shareUrl,
            status: status as "pending" | "reserved" | "attached" | "discarded",
          }
        : { title: session.title.trim() }
      : undefined;
  return {
    goalVerificationEntries: goalVerificationEntriesFromSessionEntries(entries),
    memoryEvents: [...input.memoryEvents],
    messages,
    ...(sharedContextImport ? { sharedContextImport } : {}),
    target,
  };
}

export interface ColdEventMergeDiagnostic {
  code:
    | "cold_merge.durable_event_suppressed"
    | "cold_merge.ambiguous_legacy_turn_preserved"
    | "cold_merge.settled_queue_event_suppressed"
    | "cold_merge.memory_boundary_preserved"
    | "cold_merge.non_product_event_suppressed"
    | "cold_merge.unclassified_event_preserved";
  count: number;
  eventTypes: Record<string, number>;
}

export interface ColdEventMergeResult {
  diagnostics: ColdEventMergeDiagnostic[];
  events: SessionEvent[];
  usedDurableTranscript: boolean;
}

export interface MergeInput {
  contextWindow?: number;
  fileChangeSummariesByMessageId?: ReadonlyMap<string, TurnFileChangeSummary>;
  goalVerificationEntries?: readonly HydratedGoalVerificationEntry[];
  memoryEvents: readonly SessionEvent[];
  messages: readonly MessageWithParts[];
  sessionId: string;
  target?: SessionGoal | null;
}

export const LIVE_ONLY_EVENT_TYPES = new Set<string>([
  SessionEventType.PluginUiResourceUpdated,
  SessionEventType.PluginUiResourceListChanged,
  SessionEventType.PluginUiAppToolCallRequested,
  SessionEventType.PluginUiInstanceClosed,
]);

export const MEMORY_ONLY_EVENT_TYPES = new Set<string>([
  SessionEventType.SessionResumed,
  SessionEventType.SessionTitleUpdated,
  SessionEventType.SessionModeChanged,
  SessionEventType.SessionOrchestrationChanged,
  SessionEventType.PermissionRequested,
  SessionEventType.PermissionResolved,
  SessionEventType.PermissionDenied,
  SessionEventType.UserInputAutoResolutionUpdated,
  SessionEventType.BackgroundTaskStarted,
  SessionEventType.BackgroundTaskUpdated,
  SessionEventType.BackgroundTaskCompleted,
  // workflow run 进度：权威事实在 dwf_event journal 与内存事件里，durable transcript（message/part）
  // 从不合成它，所以它与 BackgroundTask* 同类——memory-only 权威。不分类的后果不是丢事件
  // （兜底分支同样保留），而是每次冷恢复刷一条 unclassified 诊断，把"真的漏了词汇表"这个
  // 信号淹掉。
  SessionEventType.DynamicWorkflowRunProgress,
  SessionEventType.TargetChanged,
  SessionEventType.RewindTriggered,
  SessionEventType.TurnExecutionModelFallback,
]);

export const TRANSCRIPT_DERIVED_EVENT_TYPES = new Set<string>([
  SessionEventType.SessionCreated,
  SessionEventType.TurnStarted,
  SessionEventType.ModelSelected,
  SessionEventType.ModelStreaming,
  SessionEventType.ModelComplete,
  SessionEventType.ToolCallScheduled,
  SessionEventType.ToolCallStarted,
  SessionEventType.ToolCallResult,
  SessionEventType.ToolCallError,
  SessionEventType.TurnComplete,
  SessionEventType.TurnError,
  SessionEventType.CompactStarted,
  SessionEventType.CompactCompleted,
  SessionEventType.CompactFailed,
  SessionEventType.TargetCompletionVerification,
  SessionEventType.SessionForked,
  SessionEventType.SubagentSpawned,
  SessionEventType.SubagentMessage,
  SessionEventType.SubagentStopped,
]);

export const HOOK_LIFECYCLE_EVENT_TYPES = new Set<string>([
  SessionEventType.HookRunStarted,
  SessionEventType.HookRunProgress,
  SessionEventType.HookRunCompleted,
  SessionEventType.HookRunFailed,
  SessionEventType.HookRunBlocked,
]);

export function stringField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function hookInvocationTurnIds(events: readonly SessionEvent[]): Map<string, string> {
  const resolved = new Map<string, string>();
  const pending = new Set<string>();
  for (const event of events) {
    if (HOOK_LIFECYCLE_EVENT_TYPES.has(event.type)) {
      const invocationId = stringField(event.payload, "hookInvocationId");
      if (!invocationId) continue;
      const eventName = stringField(event.payload, "hookEventName");
      if (eventName === "SessionStart") {
        // startup SessionStart 可能已经携带尚未映射的 runtime turnId；只有后续真实
        // TurnStarted 才能给出 durable product turn。async terminal 若已解析则沿用。
        if (!resolved.has(invocationId)) pending.add(invocationId);
        continue;
      }
      if (event.turnId) {
        resolved.set(invocationId, String(event.turnId));
        pending.delete(invocationId);
      } else if (!resolved.has(invocationId)) {
        pending.add(invocationId);
      }
      continue;
    }
    if (event.type !== SessionEventType.TurnStarted || !event.turnId || pending.size === 0) {
      continue;
    }
    // model-only 维护 turn（manual /compact、goal continuation）没有资格承载
    // SessionStart 摘要；resume SessionStart 必须等下一条 user-visible 真实 turn 归位。
    if (stringField(event.payload, "inputVisibility") === "model-only") continue;
    // resume SessionStart 在 Runtime 中先于下一条真实 TurnStarted；cold merge 必须沿
    // 同一事件顺序建立归属，不能把它追加到历史末尾或由 Renderer 猜最近一轮。
    for (const invocationId of pending) resolved.set(invocationId, String(event.turnId));
    pending.clear();
  }
  return resolved;
}
