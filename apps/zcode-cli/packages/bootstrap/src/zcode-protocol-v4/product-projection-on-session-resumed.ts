// Modified by ZCode Feiyu.
import type { SessionEvent } from "@zcode/contracts";
import type { ConversationDelta, HookExecutionProjection } from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjection } from "./product-projection.js";

export function onSessionResumed(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const endedAt = this["ms"](event);
  const deltas: ConversationDelta[] = [];
  // Runtime epoch 切换前尚未归位的 session Hook 不得附着到新 epoch 的下一轮；
  // 新 Runtime 会重新产生自己的 resume SessionStart lifecycle。
  this["pendingSessionHookInvocations"].clear();
  for (const row of this["snapshot"].rows.window) {
    if (row.kind !== "hookInvocation" || row.state !== "running") continue;
    const executions = row.executions.map(
      (execution): HookExecutionProjection =>
        execution.state === "running"
          ? {
              ...execution,
              state: "failed",
              outcome: "cancelled",
              endedAt,
              durationMs: Math.max(0, endedAt - execution.startedAt),
            }
          : execution,
    );
    deltas.push({
      op: "row.upserted",
      row: {
        ...row,
        state: "failed",
        executions,
        endedAt,
        durationMs: Math.max(0, endedAt - row.startedAt),
      },
    });
  }
  const pendingInteractions = this["snapshot"].pendingInteractions.filter(
    (interaction) => interaction.payload.kind !== "workspaceHookReview",
  );
  if (pendingInteractions.length !== this["snapshot"].pendingInteractions.length) {
    // reviewFlowId/generation 只在单个 Runtime controller 内单调。
    // Runtime 重启后旧 Requested 会先被 replay，而新 flow 又从 generation=1 开始；
    // SessionResumed 是明确的新 Runtime epoch 边界，必须先淘汰旧 Runtime 无法再解析的审核。
    deltas.push({ op: "state.updated", patch: { pendingInteractions } });
  }
  // 软门禁:resume 后 activate 会重新上报 admission 状态。
  // epoch 清理时置 null,避免旧 Runtime 的提示条残留到新 Runtime 接管前。
  if (this["snapshot"].workspaceHookAdmission !== null) {
    deltas.push({ op: "state.updated", patch: { workspaceHookAdmission: null } });
  }
  return deltas;
}
