// Modified by ZCode Feiyu.
import type { SessionId, MessageId } from "./shared.js";

export interface ProjectMemoryReviewClaimInput {
  workspaceKey: string;
  workspacePath: string;
  currentSessionId: SessionId;
  trigger: "automatic" | "manual";
  now: number;
  leaseDurationMs: number;
  historyScope?: "workspace" | "current_session" | "none";
}

export type ProjectMemoryReviewClaim =
  | {
      status: "skipped";
      reason:
        | "initialized"
        | "cooldown"
        | "insufficient_sessions"
        | "leased"
        | "backoff"
        | "retry_exhausted"
        | "cancelled";
      /**
       * 未达门槛时同时回报进度（复审 GAP-05）：界面据此说明「距上次成功后已变化几个会话、
       * 门槛是多少」。只在 `insufficient_sessions` 时提供；其他跳过原因与门槛无关。
       */
      thresholdProgress?: import("@zcode/shared").MemoryReviewThresholdProgress;
    }
  | {
      status: "claimed";
      reviewId: string;
      epoch: number;
      sessionIds: SessionId[];
      leaseUntil: number;
    };

export interface ProjectMemoryReviewFinishInput {
  workspaceKey: string;
  reviewId: string;
  epoch: number;
  now: number;
  status: "completed" | "failed" | "cancelled";
  changedFiles: string[];
  totalTokens: number;
  /** 实际进入 gather 请求的非空会话数；省略时保留已记录的进度。 */
  sessionCount?: number;
  /** 至少一次物理请求未报告用量而保留预留；显式报告 0 不算估计。 */
  tokenUsageEstimated?: boolean;
  error?: string;
}

export interface ProjectMemoryReviewRecord {
  workspaceKey: string;
  lastSuccessAt?: number;
  reviewId?: string;
  epoch: number;
  leaseUntil?: number;
  cancelRequested: boolean;
  stage: "idle" | "locate" | "gather" | "consolidate" | "prune" | "settle";
  status: "idle" | "running" | "completed" | "failed" | "cancelled";
  nextRetryAt?: number;
  changedFiles: string[];
  totalTokens: number;
  error?: string;
  /** 认领时冻结的实际范围；旧账本未报告时不从当前设置推断。 */
  historyScope?: "workspace" | "current_session" | "none";
  /** 实际进入 gather 请求的非空会话数，不是候选 sessionIds 数量。 */
  sessionCount?: number;
  tokenUsageEstimated?: boolean;
  /** 连续自动失败次数（含过期租约）；用户取消不计入。 */
  failureCount?: number;
  /** 自动整理已因连续失败暂停，需用户手动整理开启新一轮尝试。 */
  automaticRetryExhausted?: boolean;
}

/** 来源分支已撤回/失效；批次必须终态取消，不能当作暂时 IO 失败重试。 */
export const PROJECT_MEMORY_BATCH_CANCELLED_CODE = "memory_batch_cancelled";

/** 仅在 withProjectMemoryExtractionFence 回调期间有效，固定到原 session，不再次获取协调锁。 */
export interface ProjectMemoryExtractionCursorPort {
  read(): Promise<MessageId | undefined>;
  /** 原 CAS 与同边界幂等；已退出活动分支的 nextCursor 抛 memory_batch_cancelled，不冒充 CAS 竞争。 */
  advance(input: {
    expectedCursor?: MessageId;
    nextCursor: MessageId;
    now: number;
  }): Promise<boolean>;
}
