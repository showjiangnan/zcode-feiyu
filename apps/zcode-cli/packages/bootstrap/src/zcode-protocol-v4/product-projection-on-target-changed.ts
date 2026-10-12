// Modified by ZCode Feiyu.
import type { SessionEvent, TargetChangedPayload } from "@zcode/contracts";
import type { ConversationDelta, GoalState } from "@zcode/shared/zcode-protocol-v4";
import { mapGoalStatus } from "./projection-rows.js";
import type { ProductProjection } from "./product-projection.js";

export function onTargetChanged(this: ProductProjection, event: SessionEvent): ConversationDelta[] {
  const payload = event.payload as TargetChangedPayload;
  switch (payload.action) {
    case "set": {
      if (!payload.target) return [];
      // 新目标：iteration/verifications 归零。
      // goalSet 是 stateOnly——不产 timeline row（旧实现
      // 的 goalSet marker 是「进 window 渲染 null」的隐形行，污染 turn 分组判定），
      // 目标展示归 goal 面板/状态区。
      const goal: GoalState = {
        targetId: payload.target.targetID,
        objective: payload.target.objective,
        summaryTitle: payload.target.summaryTitle,
        timeUsedSeconds: payload.target.timeUsedSeconds,
        activeRunStartedAtMs: payload.target.activeRunStartedAtMs ?? null,
        status: mapGoalStatus(payload.target.status),
        iteration: 0,
        verifications: [],
        iterations: [],
      };
      return [{ op: "state.updated", patch: this["goalPatch"](goal) }];
    }
    case "cleared": {
      if (!this["snapshot"].goal) return [];
      return [{ op: "state.updated", patch: this["goalPatch"](null) }];
    }
    default: {
      // status_updated / run_started / run_finished / usage_accounted / summary_updated：
      // 同步刷新计时与摘要标题。旧实现只比较 status，会吞掉 1 秒以上 run accounting
      // 和 summaryTitle 更新，导致刷新前后的 UI 不一致。
      const goal = this["snapshot"].goal;
      if (!goal || !payload.target) return [];
      const nextGoal: GoalState = {
        ...goal,
        targetId: payload.target.targetID,
        objective: payload.target.objective,
        summaryTitle: payload.target.summaryTitle,
        timeUsedSeconds: payload.target.timeUsedSeconds,
        activeRunStartedAtMs: payload.target.activeRunStartedAtMs ?? null,
        status: mapGoalStatus(payload.target.status),
      };
      if (
        nextGoal.targetId === goal.targetId &&
        nextGoal.objective === goal.objective &&
        nextGoal.summaryTitle === goal.summaryTitle &&
        nextGoal.timeUsedSeconds === goal.timeUsedSeconds &&
        nextGoal.activeRunStartedAtMs === goal.activeRunStartedAtMs &&
        nextGoal.status === goal.status
      ) {
        return [];
      }
      return [{ op: "state.updated", patch: this["goalPatch"](nextGoal) }];
    }
  }
}
