// Modified by ZCode Feiyu contributors (2026).
import { z } from "zod";

export const orchestrationModeSchema = z.enum(["standard", "coordinator", "swarm"]);
export type OrchestrationMode = z.infer<typeof orchestrationModeSchema>;

export const MAX_PROACTIVE_CAUSAL_DEPTH = 4;
/** 由来源 runtime 绑定到已消费输入；只传递因果事实，不授予任何权限。 */
export const proactiveCausalContextSchema = z
  .object({
    sourceCommandId: z.string().min(1).max(512),
    depth: z.number().int().min(0).max(MAX_PROACTIVE_CAUSAL_DEPTH),
  })
  .strict();
export type ProactiveCausalContext = z.infer<typeof proactiveCausalContextSchema>;

export const proactiveSubscriptionSchema = z
  .object({
    id: z.string().min(1).max(120),
    event: z.enum(["task_completed", "task_failed", "mailbox_message", "automation_due"]),
    sourceId: z.string().min(1).max(512),
    prompt: z.string().trim().min(1).max(10_000),
  })
  .strict();
export const proactiveStateSchema = z
  .object({
    status: z.enum(["stopped", "running", "paused"]),
    /**
     * running 的细分（复审 GAP-04）：`working` 表示确有模型或工具请求在途；`sleeping` 表示
     * 订阅已就绪、正在等待下一次事件唤醒。可选，旧客户端读不到时按 running 处理。
     * UI 依据它决定加载反馈：休眠不是「等待模型返回」，不得显示 loading 动画。
     */
    runtimeState: z.enum(["sleeping", "working"]).optional(),
    generation: z.number().int().nonnegative(),
    consecutiveTurns: z.number().int().nonnegative().optional(),
    subscriptions: z.array(proactiveSubscriptionSchema).max(20),
    reason: z.string().nullable(),
  })
  .strict();
export type ProactiveState = z.infer<typeof proactiveStateSchema>;
export type ProactiveSubscription = z.infer<typeof proactiveSubscriptionSchema>;
export const DEFAULT_PROACTIVE_STATE: ProactiveState = {
  status: "stopped",
  generation: 0,
  subscriptions: [],
  reason: null,
};

export const orchestrationStateSchema = z.object({
  requested: orchestrationModeSchema,
  effective: orchestrationModeSchema,
  revision: z.number().int().nonnegative(),
  proactive: proactiveStateSchema.optional(),
});
export type OrchestrationState = z.infer<typeof orchestrationStateSchema>;

/** 只恢复已移除的执行限制暂停；用户暂停、停止及撤权均保持原事实。 */
export function resumeRetiredExecutionPause(
  state: OrchestrationState,
  allowed: boolean,
): OrchestrationState {
  const current = state.proactive;
  if (
    !allowed ||
    current?.status !== "paused" ||
    !(current.reason?.startsWith("budget_exhausted:") || current.reason?.startsWith("turn_limit:"))
  )
    return state;
  return {
    ...state,
    revision: state.revision + 1,
    proactive: {
      ...current,
      status: "running",
      runtimeState: "sleeping",
      reason: null,
      generation: current.generation + 1,
    },
  };
}

export const DEFAULT_ORCHESTRATION_STATE: OrchestrationState = Object.freeze({
  requested: "standard",
  effective: "standard",
  revision: 0,
});
