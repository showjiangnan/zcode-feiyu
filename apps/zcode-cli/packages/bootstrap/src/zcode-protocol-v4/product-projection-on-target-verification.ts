// Modified by ZCode Feiyu.
import type { SessionEvent, TargetCompletionVerificationPayload } from "@zcode/contracts";
import type {
  ConversationDelta,
  TimelineMarkerRow,
  GoalState,
  TimelineMarkerPayload,
  SessionControl,
} from "@zcode/shared/zcode-protocol-v4";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjection } from "./product-projection.js";

export function onTargetVerification(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TargetCompletionVerificationPayload;
  const goal = this["snapshot"].goal;
  // goal verify boundary 不依赖 goal 状态在场。
  // 冷恢复合成事件流没有 TargetChanged → goal 为 null，旧实现在此整条丢弃
  // verification 事实，刷新后 goalVerify marker 消失。现在 marker
  // 恒生成/恒更新；goal 状态 patch 仍只在 goal 在场时生效。
  if (payload.status === "started") {
    const iteration = payload.goalIteration ?? (goal ? goal.iteration + 1 : 1);
    const lifecycleKey = this["goalVerifyLifecycleKey"](payload, iteration);
    const verifyingGoal = goal ? { ...goal, status: "verifying" as const, iteration } : undefined;
    const otherWorks = this["snapshot"].control.activeWorks.filter(
      (work) => work.kind !== "goalVerifier",
    );
    const controlDelta: ConversationDelta = {
      op: "state.updated",
      patch: this["controlPatch"](
        {
          phase: "running",
          sessionEnded: false,
          activeWorks: [
            ...otherWorks,
            {
              kind: "goalVerifier",
              ...(payload.foregroundExecutionId
                ? { foregroundExecutionId: payload.foregroundExecutionId }
                : {}),
              startedAt: this["ms"](event),
            },
          ],
          canStop: true,
          stopState: "stoppable",
          stopTargetKind: otherWorks.length > 0 ? ("mixed" as const) : ("goalVerifier" as const),
          lastError: null,
          apiRetry: null,
        },
        verifyingGoal,
      ),
    };
    // GV-identity：同 targetId+iteration 的重试（新 verificationId）复用同一 marker
    // 行回到 running，不长出第二个 marker。
    const existingRowId = this["goalVerifyMarkerRowIdByLifecycleKey"].get(lifecycleKey);
    const existingRow = existingRowId !== undefined ? this["findRow"](existingRowId) : undefined;
    if (existingRow?.kind === "timelineMarker") {
      return [
        {
          op: "row.upserted",
          row: {
            ...existingRow,
            marker: { type: "goalVerify", iteration, outcome: "running" },
          },
        },
        controlDelta,
      ];
    }
    const row: TimelineMarkerRow = {
      ...this["rowBase"](event, this["goalVerifyTurnId"](payload, event), lifecycleKey),
      kind: "timelineMarker",
      lane: "turnTailBoundary",
      marker: { type: "goalVerify", iteration, outcome: "running" },
    };
    this["goalVerifyMarkerRowIdByLifecycleKey"].set(lifecycleKey, row.rowId);
    return [{ op: "row.appended", row }, controlDelta];
  }
  // 终态：completed（pass/notSatisfied 是有效结论）/ failed_closed（验证过程失败）
  // / cancelled（被 stop：过程未产出结论 → marker=failed(detail=cancelled)，goal 回 paused）。
  const iteration = payload.goalIteration ?? goal?.iteration ?? 1;
  const outcome: "pass" | "notSatisfied" | "failed" =
    payload.status === "completed"
      ? payload.verification?.passed
        ? "pass"
        : "notSatisfied"
      : "failed";
  const goalStatus: GoalState["status"] =
    payload.status === "cancelled"
      ? "paused"
      : payload.status === "failed_closed"
        ? "failed"
        : outcome === "pass"
          ? "verified"
          : "notSatisfied";
  const deltas: ConversationDelta[] = [];
  const lifecycleKey = this["goalVerifyLifecycleKey"](payload, iteration);
  const markerRowId = this["goalVerifyMarkerRowIdByLifecycleKey"].get(lifecycleKey);
  let anchorRowId: number | null = null;
  const markerRow = markerRowId !== undefined ? this["findRow"](markerRowId) : undefined;
  const terminalMarker: TimelineMarkerPayload = {
    type: "goalVerify",
    iteration,
    outcome,
    ...(payload.status === "cancelled"
      ? { detail: "cancelled" }
      : payload.verification?.reason
        ? { detail: payload.verification.reason }
        : {}),
  };
  if (markerRow?.kind === "timelineMarker") {
    anchorRowId = markerRow.rowId;
    deltas.push({
      op: "row.upserted",
      row: { ...markerRow, marker: terminalMarker },
    });
  } else {
    // GV-terminal-only：boundary 按 lifecycleKey upsert——任一生命周期
    // 事件先到都能创建实体。旧实现终态找不到 started marker 就整条丢弃（冷恢复
    // 后到达的终态、started 事件丢帧都触发）。
    const row: TimelineMarkerRow = {
      ...this["rowBase"](event, this["goalVerifyTurnId"](payload, event), lifecycleKey),
      kind: "timelineMarker",
      lane: "turnTailBoundary",
      marker: terminalMarker,
    };
    this["goalVerifyMarkerRowIdByLifecycleKey"].set(lifecycleKey, row.rowId);
    anchorRowId = row.rowId;
    deltas.push({ op: "row.appended", row });
  }
  const hadGoalVerifierWork = this["snapshot"].control.activeWorks.some(
    (work) => work.kind === "goalVerifier",
  );
  const shouldPatchControl = hadGoalVerifierWork || this["snapshot"].goal?.status === "verifying";
  const otherWorks = this["snapshot"].control.activeWorks.filter(
    (work) => work.kind !== "goalVerifier",
  );
  const terminalPhase: SessionControl["phase"] =
    payload.status === "cancelled"
      ? "completedInterrupted"
      : payload.status === "failed_closed"
        ? "error"
        : "completedSuccess";
  const heldQueue =
    payload.status === "cancelled" &&
    payload.preserveQueueAutoDrainOnCancel !== true &&
    this["snapshot"].queue.items.length > 0
      ? {
          ...this["snapshot"].queue,
          autoDrain: false,
          pauseReason: "stopped" as const,
        }
      : undefined;
  // goal 不在场（冷恢复合成流）：marker 行仍要保留；只有当前 live control
  // 确实处于 verifier work 时才收口 control，避免 terminal-only 历史事实把 draft
  // 冷恢复快照误推进成 completed。
  if (!goal) {
    if (!shouldPatchControl) return deltas;
    deltas.push({
      op: "state.updated",
      patch: this["controlPatch"](
        {
          phase: terminalPhase,
          sessionEnded: terminalPhase !== "error",
          activeWorks: otherWorks,
          ...(otherWorks.length === 0
            ? {
                canStop: false,
                stopState: "idle" as const,
                stopTargetKind: "unknown" as const,
              }
            : {
                stopTargetKind: "mixed" as const,
              }),
        },
        undefined,
        heldQueue,
      ),
    });
    return deltas;
  }
  // verifications 只记结论（cancelled 不是结论，不入摘要）；最近 N 条。
  const verifications =
    payload.status === "cancelled"
      ? goal.verifications
      : [
          ...goal.verifications,
          {
            iteration,
            outcome,
            at: this["ms"](event),
            anchorRowId,
            ...(payload.verification?.reason ? { reason: payload.verification.reason } : {}),
            ...(payload.verification?.nextAction
              ? { nextAction: payload.verification.nextAction }
              : {}),
          },
        ].slice(-PROTOCOL_V4_LIMITS.goalVerificationsRetained);
  const nextGoal = {
    ...goal,
    status: goalStatus,
    iteration,
    verifications,
  };
  deltas.push({
    op: "state.updated",
    patch: shouldPatchControl
      ? this["controlPatch"](
          {
            phase: terminalPhase,
            sessionEnded: terminalPhase !== "error",
            activeWorks: otherWorks,
            ...(otherWorks.length === 0
              ? {
                  canStop: false,
                  stopState: "idle" as const,
                  stopTargetKind: "unknown" as const,
                }
              : {
                  stopTargetKind: "mixed" as const,
                }),
          },
          nextGoal,
          heldQueue,
        )
      : this["goalPatch"](nextGoal),
  });
  return deltas;
}
