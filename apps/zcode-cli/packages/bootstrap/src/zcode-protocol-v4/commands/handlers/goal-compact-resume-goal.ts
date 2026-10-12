// Modified by ZCode Feiyu.
import type { V4CommandCoreHost } from "../types.js";
import type { CommandEnvelope, CommandResult } from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import { V4GoalCompactRejectedError } from "./goal-compact-v4-goal-compact-rejected-error.js";
import { continueGoalAfterChange } from "./goal-compact-run-goal-continuation-in-background.js";

/**
 * resumeGoal：paused → active（stopPausesActiveGoalTarget 的逆操作）。
 * 无 target → 幂等成功（旧协议路径返回 "No goal to resume." 且不改状态，不抛错）。
 */
export async function resumeGoal(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (record.activeAbortController) {
    // 同 sendGoalCommand：resume 属旧 goalSession 的非 pause 动作，运行中拒绝。
    throw new V4GoalCompactRejectedError(
      "activeTurn",
      "Cannot manage goals while a prompt is running",
    );
  }
  // 只跳过续跑仍会留下 active Goal + Plan；恢复目标前就检查，不能先写入再拒绝。
  const planEnabled = record.app.runtime?.getPlanEnabled?.() ?? record.app.getMode?.() === "plan";
  if (planEnabled && (await record.app.readTarget())) {
    throw new V4GoalCompactRejectedError(
      "guard.planGoalMutuallyExclusive",
      "Plan and Goal cannot be active at the same time.",
    );
  }
  const target = await record.app.updateTargetStatus("active");
  if (!target) {
    host.logger?.info?.("v4 resumeGoal without target, noop", {
      commandId: envelope.commandId,
      sessionId: record.app.sessionId,
    });
    return undefined;
  }
  await continueGoalAfterChange(host, record, {
    inputId: envelope.commandId,
    reason: "goal_resumed",
  });
  return undefined;
}

export const goalCompactHandlers = { compact, pauseGoal, resumeGoal, sendGoalCommand };
import { compact } from "./goal-compact-v4-goal-compact-rejected-error.js";
import { pauseGoal, sendGoalCommand } from "./goal-compact-run-goal-continuation-in-background.js";
