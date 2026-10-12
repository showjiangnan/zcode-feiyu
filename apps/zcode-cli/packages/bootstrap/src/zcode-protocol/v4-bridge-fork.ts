// Modified by ZCode Feiyu.
import type {
  CollaborationMode,
  ForkCommitBundle,
  SessionEvent,
  SessionEventStorePort,
  SessionId,
  SessionStorePort,
} from "@zcode/contracts";
import { SessionEventType, createEventId } from "@zcode/contracts";

import {
  conversationInputIntentSchema,
  type CommandEnvelope,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";

import { queueItemIdForCommand } from "../zcode-protocol-v4/command-inbox.js";

import { persistHighspeedTiming } from "../zcode-protocol-v4/highspeed-metrics-persistence.js";

import { registerForkedSession } from "./server-operations.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";

import { type InputCommandForAdmission } from "./v4-bridge-input.js";
// 按职责拆分；保留原始规则、执行顺序与状态所有者。

export const STABLE_FORK_MODES = new Set<CollaborationMode>([
  "plan",
  "build",
  "edit",
  "yolo",
  "guarded",
  "auto",
]);

export function stableForkMode(value: string, fallback: CollaborationMode): CollaborationMode {
  return STABLE_FORK_MODES.has(value as CollaborationMode)
    ? (value as CollaborationMode)
    : fallback;
}

export function buildForkInitialInput(
  envelope: CommandEnvelope,
  childSessionId: string,
  admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  input: InputCommandForAdmission,
): ForkCommitBundle["initialInput"] {
  const requested = input.requestedDelivery ?? "startNow";
  const fallbackReasonCode = input.fallbackReasonCode;
  const admitted =
    input.admittedDelivery ??
    (fallbackReasonCode ? "queue" : requested === "auto" ? "startNow" : requested);
  const intent = conversationInputIntentSchema.parse({
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId: envelope.clientId || "cli",
    kind: input.kind,
    ...(input.inputOrigin ? { inputOrigin: input.inputOrigin } : {}),
    ...(input.conversationQuotes ? { conversationQuotes: input.conversationQuotes } : {}),
    ...(input.botGroupSource ? { botGroupSource: input.botGroupSource } : {}),
    text: input.text,
    attachments: input.attachments,
    delivery: {
      requested,
      admitted,
      ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
    },
    order: { admissionSeq: admission.admissionSeq },
    steer: fallbackReasonCode
      ? { state: "fellBack", reasonCode: fallbackReasonCode }
      : { state: "notRequested" },
    dispatch: { state: "admitted" },
    admittedAt: admission.admittedAt,
    ...(input.highspeed ? { highspeed: input.highspeed } : {}),
    ...(input.provenance ? { provenance: input.provenance } : {}),
  });
  return {
    id: admission.queueItemId,
    sessionID: childSessionId as SessionId,
    kind: intent.kind,
    delivery: intent.delivery.admitted,
    payload: {
      text: intent.text,
      conversationInputIntent: intent,
      attachments: intent.attachments,
      sourceCommandType: envelope.type,
    },
  };
}

export async function recordForkStartFailureBestEffort(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  command: Pick<CommandEnvelope, "commandId">,
  error: unknown,
  details: { parentSessionId?: string; registrationRequired?: boolean } = {},
): Promise<void> {
  const store = context.deps.sessionStore;
  const record = context.sessions.get(sessionId);
  const now = Date.now();
  const message = error instanceof Error ? error.message : String(error);
  const warn = (stage: string, failure: unknown) => {
    try {
      context.logger?.warn("fork child post-commit failure recording degraded", {
        commandId: command.commandId,
        error: failure instanceof Error ? failure.message : String(failure),
        forkedSessionId: sessionId,
        parentSessionId: details.parentSessionId,
        stage,
      });
    } catch {
      // 日志 sink 失败也属于 post-commit；durable child/fact 不得因此反转。
    }
  };

  try {
    await store?.settleSessionInput?.({
      id: queueItemIdForCommand(command.commandId),
      sessionID: sessionId as SessionId,
      status: "failed",
      reason: "fault.command.childStartFailed",
    });
  } catch (failure) {
    warn("ledger", failure);
  }
  try {
    await store?.saveSessionEntry?.({
      id: `v4_fork_start_failure:${command.commandId}`,
      sessionID: sessionId as SessionId,
      type: "v4/fork_start_failure",
      time: { created: now, updated: now },
      data: {
        commandId: command.commandId,
        forkedSessionId: sessionId,
        parentSessionId: details.parentSessionId,
        ...(details.registrationRequired ? { registrationRequired: true } : {}),
        retryable: true,
        status: "failed",
        reasonCode: "fault.command.childStartFailed",
        message,
      },
    });
  } catch (failure) {
    warn("entry", failure);
  }
  if (!record) return;
  try {
    const event: SessionEvent = {
      id: createEventId(),
      sessionId: sessionId as SessionId,
      type: SessionEventType.TurnError,
      timestamp: new Date(now),
      traceId: record.traceContext.traceId,
      sequenceNumber: (await record.eventStore.getLatestSequenceNumber(sessionId as SessionId)) + 1,
      payload: {
        inputId: command.commandId,
        turnPhase: "fork_child_start",
        error: {
          type: "fault.command.childStartFailed",
          message,
          retryable: true,
        },
      },
    };
    const persisted = await record.eventStore.append(event);
    context.v4Gateway?.ingest(sessionId, persisted);
  } catch (failure) {
    warn("event", failure);
  }
}

/**
 * Fork bundle commit 是命令 PONR；后续 catalog/model/resume/snapshot 仅恢复 runtime 可达性。
 * 该阶段失败必须留下可重试事实与 warning，但不能把 durable accepted child 反转成 failed。
 */
export async function registerCommittedForkBestEffort(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  fork: Parameters<typeof registerForkedSession>[2],
  options: Parameters<typeof registerForkedSession>[3] & { commandId: string },
  register: typeof registerForkedSession = registerForkedSession,
): Promise<void> {
  const { commandId, ...registrationOptions } = options;
  try {
    await register(context, record, fork, registrationOptions);
  } catch (error) {
    const forkedSessionId = String(fork.forkedSessionId);
    const parentSessionId = String(fork.parentSessionId ?? record.app.sessionId);
    await recordForkStartFailureBestEffort(context, forkedSessionId, { commandId }, error, {
      parentSessionId,
      registrationRequired: true,
    });
    try {
      context.logger?.warn("fork child registration failed after durable commit", {
        commandId,
        error: error instanceof Error ? error.message : String(error),
        forkedSessionId,
        parentSessionId,
        retryable: true,
      });
    } catch {
      // logger 自身异常过去会越过 PONR 冒泡，让 gateway 错误 settle 为 failed。
    }
  }
}

/** turn 终态耗时持久化所需的窄化上下文；结构化类型保证与完整 server context 兼容。 */
export interface HighspeedTurnTerminalPersistenceContext {
  sessions: Map<
    string,
    { eventStore: SessionEventStorePort; traceContext: { traceId: string | number } }
  >;
  deps: { sessionStore?: SessionStorePort };
  v4Gateway?: { ingest(sessionId: string, event: SessionEvent): unknown };
  logger?: { warn(message: string, data?: Record<string, unknown>): void };
}

/**
 * turn 终态钩子：把投影累计的真实耗时拆分落到 transcript 的 metadata.highspeed。
 * Bug 根因（2026-08-31 审计 #1）：该钩子由 gateway 对所有 TurnComplete/TurnError 触发，
 * 且投影对普通 turn 也写入 modelDurationMs/toolDurationMs，原“双 undefined 才返回”的
 * 守卫永不生效——每个普通 turn 终态都会先做一次全量 sessionStore.messages() 扫描，
 * 最后才因 metadata.highspeed 缺失返回，长会话热路径白白承担 O(N) I/O。
 * userInput row 自带持久化的 highspeed 身份，进入扫描前先按它短路。
 */
export function persistHighspeedTimingOnTurnTerminal(
  context: HighspeedTurnTerminalPersistenceContext,
  sessionId: string,
  event: SessionEvent,
  snapshot: ConversationSnapshot,
): void {
  const record = context.sessions.get(sessionId);
  const sessionStore = context.deps.sessionStore;
  const payload = event.payload as { inputId?: unknown; duration?: unknown };
  const inputId = typeof payload.inputId === "string" ? payload.inputId : undefined;
  const header = snapshot.rows.window
    .filter(
      (row): row is Extract<(typeof snapshot.rows.window)[number], { kind: "turnHeader" }> =>
        row.kind === "turnHeader" &&
        (inputId === undefined
          ? row.turnId === String(event.turnId)
          : row.sourceCommandId === inputId),
    )
    .at(-1);
  if (!record || !sessionStore || !header?.sourceCommandId) return;
  const user = snapshot.rows.window.find(
    (row) => row.kind === "userInput" && row.sourceCommandId === header.sourceCommandId,
  );
  if (!user || user.kind !== "userInput") return;
  if (!user.highspeed) return;
  if (header.modelDurationMs === undefined && header.toolDurationMs === undefined) {
    return;
  }
  void persistHighspeedTiming({
    sessionStore,
    eventStore: record.eventStore,
    sessionId,
    sourceCommandId: header.sourceCommandId,
    timing: {
      modelDurationMs: header.modelDurationMs ?? 0,
      toolDurationMs: header.toolDurationMs ?? 0,
      otherDurationMs: header.otherDurationMs ?? 0,
    },
    ...(header.outputTokens !== undefined ? { outputTokens: header.outputTokens } : {}),
    ...(header.activeMs !== undefined ? { durationMs: header.activeMs } : {}),
    // fallbackAt 只存在于 live 投影：终态一并写入 transcript，HighspeedMetricsUpdated 与 cold
    // hydration 才不会丢掉它（spec §5）。
    ...(user.highspeed.fallbackAt !== undefined ? { fallbackAt: user.highspeed.fallbackAt } : {}),
    ...(user.highspeed.fallbackReason !== undefined
      ? { fallbackReason: user.highspeed.fallbackReason }
      : {}),
    traceId: String(record.traceContext.traceId),
    onPersistedEvent: (persisted) => context.v4Gateway?.ingest(sessionId, persisted),
    onLiveProjectionError: (error) =>
      context.logger?.warn("v4 highspeed timing live projection failed", {
        error: error instanceof Error ? error.message : String(error),
        sessionId,
      }),
  }).catch((error) => {
    context.logger?.warn("v4 highspeed timing persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      sessionId,
    });
  });
}
