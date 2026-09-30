// Modified by ZCode Feiyu contributors (2026).
import { z } from "zod";

/**
 * 自动整理的门槛（复审 GAP-05）。
 *
 * 修复原因：门槛此前只是适配层里的私有常量，UI 无法说明「还差几个会话」，用户只看到
 * 自动整理开着却什么都不发生。依据：CONT-ui.md 要求自动整理开启但未达门槛时展示距上次成功
 * 的候选会话数与门槛进度。执行端与界面共用这一个常量，避免两边各写一个数字而漂移。
 */
export const MEMORY_REVIEW_THRESHOLD = {
  /** workspace 范围下，距上次成功后需要出现变化的其它顶层会话数。 */
  workspaceOtherSessions: 5,
  /** current_session 范围下只针对选定会话，门槛为 1。 */
  currentSessionSessions: 1,
  none: 0,
} as const;

export const memoryReviewThresholdProgressSchema = z
  .object({
    /** 统计口径：与整理记录里冻结的 historyScope 一致。 */
    historyScope: z.enum(["workspace", "current_session", "none"]),
    /** 已达门槛的候选会话数。 */
    progressedSessions: z.number().int().nonnegative(),
    /** 门槛本身；none 范围下为 0。 */
    requiredSessions: z.number().int().nonnegative(),
    /** 供界面展示的进度；门槛为 0 时视作已达成。 */
    reachedThreshold: z.boolean(),
  })
  .strict();
export type MemoryReviewThresholdProgress = z.infer<typeof memoryReviewThresholdProgressSchema>;

export function resolveMemoryReviewThreshold(
  scope: MemoryReviewThresholdProgress["historyScope"],
): number {
  return scope === "workspace"
    ? MEMORY_REVIEW_THRESHOLD.workspaceOtherSessions
    : scope === "current_session"
      ? MEMORY_REVIEW_THRESHOLD.currentSessionSessions
      : MEMORY_REVIEW_THRESHOLD.none;
}

/** 门槛进度是纯计算：执行端的准入与界面的说明都从这里取值。 */
export function memoryReviewThresholdProgress(input: {
  historyScope: MemoryReviewThresholdProgress["historyScope"];
  progressedSessions: number;
}): MemoryReviewThresholdProgress {
  const requiredSessions = resolveMemoryReviewThreshold(input.historyScope);
  const progressedSessions = Math.max(0, Math.trunc(input.progressedSessions));
  return {
    historyScope: input.historyScope,
    progressedSessions,
    requiredSessions,
    reachedThreshold: requiredSessions === 0 || progressedSessions >= requiredSessions,
  };
}

const currentContinuityPolicySchema = z
  .object({
    proactiveWorkAllowed: z.boolean().default(false),
    memoryHistoryScope: z.enum(["workspace", "current_session", "none"]).default("workspace"),
  })
  .strict();
/** 旧消费字段只在读取边界丢弃，未知设置仍严格报错，避免旧配置使许可整份回落默认。 */
export const continuityPolicySchema = z.preprocess((input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const {
    taskBudget: _retiredBudget,
    proactiveTurnLimit: _retiredLimit,
    ...current
  } = input as Record<string, unknown>;
  return current;
}, currentContinuityPolicySchema);
export type ContinuityPolicy = z.infer<typeof continuityPolicySchema>;
export const DEFAULT_CONTINUITY_POLICY: ContinuityPolicy = continuityPolicySchema.parse({});

export const memoryHistoryEntrySchema = z
  .object({
    operationId: z.string(),
    path: z.string(),
    sourceSessionId: z.string(),
    before: z.string().nullable(),
    after: z.string().nullable(),
    beforeHash: z.string().nullable(),
    afterHash: z.string().nullable(),
    state: z.enum(["prepared", "committed", "aborted", "conflict"]),
    createdAt: z.number(),
  })
  .strict();
export type MemoryHistoryEntry = z.infer<typeof memoryHistoryEntrySchema>;
export const memoryHistorySummarySchema = memoryHistoryEntrySchema.omit({
  before: true,
  after: true,
});
export type MemoryHistorySummary = z.infer<typeof memoryHistorySummarySchema>;
export const memoryReviewRunSchema = z
  .object({
    reviewId: z.string(),
    trigger: z.enum(["automatic", "manual"]),
    sessionIds: z.array(z.string()),
    historyScope: z.enum(["workspace", "current_session", "none"]).optional(),
    sessionCount: z.number().int().nonnegative().optional(),
    tokenUsageEstimated: z.boolean().optional(),
    stage: z.enum(["idle", "locate", "gather", "consolidate", "prune", "settle"]).optional(),
    startedAt: z.number(),
    finishedAt: z.number().nullable(),
    status: z.enum(["running", "completed", "failed", "cancelled"]),
    changedFiles: z.array(z.string()),
    totalTokens: z.number(),
    error: z.string().nullable(),
  })
  .strict();
export type MemoryReviewRun = z.infer<typeof memoryReviewRunSchema>;
export const backgroundContinuityStopRecordSchema = z
  .object({
    requestId: z.string(),
    reason: z.enum(["user_requested", "permission_revoked", "app_quit"]),
    startedAt: z.number(),
    finishedAt: z.number(),
    outcome: z.enum(["completed", "partial_failure", "failed"]),
    targets: z.array(
      z
        .object({
          windowId: z.number().int(),
          status: z.enum(["stopped", "failed"]),
          error: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type BackgroundContinuityStopRecord = z.infer<typeof backgroundContinuityStopRecordSchema>;

export const backgroundContinuityStatusSchema = z
  .object({
    supported: z.boolean(),
    enabled: z.boolean(),
    state: z.enum(["disabled", "ready", "running", "stopping", "failed"]),
    hosts: z.array(
      z
        .object({
          windowId: z.number().int(),
          visible: z.boolean(),
          ready: z.boolean(),
          runningTasks: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    error: z.string().nullable(),
    /** 当前 Main 生命周期内最近 20 次真实原生停止结果；旧客户端可不提供。 */
    stopHistory: z.array(backgroundContinuityStopRecordSchema).optional(),
  })
  .strict();
export type BackgroundContinuityStatus = z.infer<typeof backgroundContinuityStatusSchema>;
export const runtimeCapabilitySchema = z
  .object({
    supported: z.boolean(),
    enabled: z.boolean(),
    available: z.boolean(),
    reason: z.string().nullable(),
    policyRevision: z.number().int().nonnegative(),
  })
  .strict();
export type RuntimeCapability = z.infer<typeof runtimeCapabilitySchema>;
