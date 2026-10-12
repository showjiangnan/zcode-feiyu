// Modified by ZCode Feiyu.
import type {
  TargetCompletionVerificationPayload,
  SessionEvent,
  SessionForkedPayload,
} from "@zcode/contracts";
import type {
  ConversationDelta,
  TimelineMarkerRow,
  SessionControl,
  GoalState,
  ConversationSnapshot,
  StatePatch,
} from "@zcode/shared/zcode-protocol-v4";
import { computeAvailability, computeInputRouting } from "./projection-state.js";
import type { ProductProjection } from "./product-projection.js";

export function goalVerifyLifecycleKey(
  this: ProductProjection,
  payload: TargetCompletionVerificationPayload,
  iteration: number,
): string {
  return payload.targetId ? `${payload.targetId}_${iteration}` : payload.verificationId;
}

export function goalVerifyTurnId(
  this: ProductProjection,
  payload: TargetCompletionVerificationPayload,
  event: SessionEvent,
): string {
  const anchorMessageId = payload.anchorAssistantMessageId
    ? String(payload.anchorAssistantMessageId)
    : null;
  if (anchorMessageId) {
    const rowId = this["rowIdForMessageId"](anchorMessageId);
    const row = rowId !== null ? this["findRow"](rowId) : undefined;
    if (row) return row.turnId;
  }
  const anchorTurnId = payload.anchorTurnId ? String(payload.anchorTurnId) : null;
  if (anchorTurnId) {
    const mapped = this["productTurnIdByRuntimeTurnId"].get(anchorTurnId) ?? anchorTurnId;
    if (this["turnHeaderRowIdByTurnId"].has(mapped)) return mapped;
  }
  return this["turnIdOf"](event);
}

export function onSessionForked(this: ProductProjection, event: SessionEvent): ConversationDelta[] {
  const payload = event.payload as SessionForkedPayload;
  const isParent = String(payload.originalSessionId) === this["snapshot"].sessionId;
  if (isParent) {
    // 父时间线不显示 forkCreated——fork 关系只在 sessions
    // 树/列表体现。旧实现以 nextRowId-1 近似锚点产 row，且 UI 渲染为 null
    // （隐形行污染 turn 分组）；child 首部 forkNotice 保留不变。
    return [];
  }
  // child 首部 forkNotice（forkTimelineIsBoundary）：事件 payload 不携带
  // parent 侧 rowId，先以 0 占位；transcript 锚点 → rowId 映射随传输外壳补齐。
  const row: TimelineMarkerRow = {
    ...this["rowBase"](
      event,
      this["turnIdOf"](event),
      `fork:${String(payload.originalSessionId)}:${String(payload.targetMessageId ?? "unknown")}`,
    ),
    kind: "timelineMarker",
    lane: "turnTailBoundary",
    marker: {
      type: "forkNotice",
      parentSessionId: String(payload.originalSessionId),
      parentRowId: 0,
    },
  };
  return [{ op: "row.appended", row }];
}

export function controlPatch(
  this: ProductProjection,
  control: Partial<SessionControl>,
  goal?: GoalState | null,
  queue?: ConversationSnapshot["queue"],
): StatePatch {
  const next: SessionControl = { ...this["snapshot"].control, ...control };
  const nextGoal = goal === undefined ? this["snapshot"].goal : goal;
  const nextQueue = queue ?? this["snapshot"].queue;
  const context = {
    phase: next.phase,
    goalStatus: nextGoal?.status ?? null,
    // compacting 不是独立 phase（封闭枚举），从 activeWorks 派生。
    compacting: next.activeWorks.some((work) => work.kind === "compact"),
    goalVerifying: next.activeWorks.some((work) => work.kind === "goalVerifier"),
    queueLength: nextQueue.items.length,
    autoDrain: nextQueue.autoDrain,
  };
  return {
    control: next,
    ...(goal === undefined ? {} : { goal }),
    ...(queue === undefined ? {} : { queue }),
    availability: computeAvailability(context),
    inputRouting: computeInputRouting(context, this["snapshot"].config.followupMode),
  };
}

export function goalPatch(this: ProductProjection, goal: GoalState | null): StatePatch {
  return {
    goal,
    availability: computeAvailability(this["deriveContext"]({ goal })),
  };
}

export function queuePatch(
  this: ProductProjection,
  queue: ConversationSnapshot["queue"],
): StatePatch {
  const context = this["deriveContext"]({ queue });
  return {
    queue,
    availability: computeAvailability(context),
    inputRouting: computeInputRouting(context, this["snapshot"].config.followupMode),
  };
}

export function deriveContext(
  this: ProductProjection,
  overrides: {
    goal?: GoalState | null;
    queue?: ConversationSnapshot["queue"];
  },
): {
  phase: "error" | "draft" | "prewarming" | "running" | "completedSuccess" | "completedInterrupted";
  goalStatus: "paused" | "failed" | "active" | "verifying" | "verified" | "notSatisfied" | null;
  compacting: boolean;
  goalVerifying: boolean;
  queueLength: number;
  autoDrain: boolean;
} {
  const goal = overrides.goal === undefined ? this["snapshot"].goal : overrides.goal;
  const queue = overrides.queue ?? this["snapshot"].queue;
  return {
    phase: this["snapshot"].control.phase,
    goalStatus: goal?.status ?? null,
    compacting: this["snapshot"].control.activeWorks.some((work) => work.kind === "compact"),
    goalVerifying: this["snapshot"].control.activeWorks.some(
      (work) => work.kind === "goalVerifier",
    ),
    queueLength: queue.items.length,
    autoDrain: queue.autoDrain,
  };
}

export function upsertTurnHeader(
  this: ProductProjection,
  event: SessionEvent,
  state: "completedSuccess" | "completedInterrupted" | "failed",
  activeMs?: number,
  historyRoundCount?: number,
  highspeedTiming?: {
    modelDurationMs: number;
    toolDurationMs: number;
    otherDurationMs: number;
  },
): ConversationDelta[] {
  const row = this["turnHeaderForEvent"](event);
  if (!row) return [];
  const endedAt = this["ms"](event);
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        state,
        endedAt,
        ...(activeMs !== undefined ? { activeMs } : {}),
        ...highspeedTiming,
        ...(historyRoundCount !== undefined ? { historyRoundCount } : {}),
        ...(row.workSegments
          ? {
              workSegments: this["completeWorkSegments"](row.workSegments, endedAt),
            }
          : {}),
      },
    },
  ];
}

export function recordHighspeedToolStarted(
  this: ProductProjection,
  turnId: string,
  toolCallId: string,
  startedAt: number,
): void {
  const intervals = this["highspeedToolIntervalsByTurnId"].get(turnId) ?? new Map();
  intervals.set(toolCallId, { startedAt });
  this["highspeedToolIntervalsByTurnId"].set(turnId, intervals);
}

export function recordHighspeedToolEnded(
  this: ProductProjection,
  turnId: string,
  toolCallId: string,
  endedAt: number,
  durationMs?: number,
): void {
  const intervals = this["highspeedToolIntervalsByTurnId"].get(turnId) ?? new Map();
  const existing = intervals.get(toolCallId);
  const startedAt = existing?.startedAt ?? Math.max(0, endedAt - Math.max(0, durationMs ?? 0));
  intervals.set(toolCallId, {
    startedAt,
    endedAt: Math.max(
      startedAt,
      existing && durationMs !== undefined ? startedAt + durationMs : endedAt,
    ),
  });
  this["highspeedToolIntervalsByTurnId"].set(turnId, intervals);
}
