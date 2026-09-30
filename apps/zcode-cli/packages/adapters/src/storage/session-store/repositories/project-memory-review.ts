// Modified by ZCode Feiyu contributors (2026).
import { selectReviewCandidates } from "./project-memory-review-candidates.js";
export { readProjectMemoryReviewThreshold } from "./project-memory-review-candidates.js";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type ProjectMemoryReviewClaim,
  type ProjectMemoryReviewClaimInput,
  type ProjectMemoryReviewFinishInput,
  type ProjectMemoryReviewRecord,
} from "@zcode/contracts";
import type { MemoryReviewRun } from "@zcode/shared";
import { MEMORY_REVIEW_THRESHOLD, memoryReviewThresholdProgress } from "@zcode/shared";

const REVIEW_INTERVAL_MS = 24 * 60 * 60 * 1_000;
// 门槛与界面共用同一个常量，避免两处各写一个数字后漂移（复审 GAP-05）。
const REQUIRED_OTHER_SESSIONS = MEMORY_REVIEW_THRESHOLD.workspaceOtherSessions;
const BASE_RETRY_MS = 5 * 60 * 1_000;
const MAX_RETRY_MS = 24 * 60 * 60 * 1_000;
const MAX_AUTOMATIC_FAILURES = 5;
const MAX_CHANGED_FILES = 100;
const MAX_ERROR_CHARS = 500;

type Stage = ProjectMemoryReviewRecord["stage"];
interface ReviewProgressRow {
  history_scope: NonNullable<ProjectMemoryReviewRecord["historyScope"]> | null;
  session_count: number | null;
  token_usage_estimated: number | null;
  changed_files_json: string;
  total_tokens: number;
}
interface ReviewRow extends ReviewProgressRow {
  baseline_at: number;
  last_success_at: number | null;
  review_id: string | null;
  epoch: number;
  lease_until: number | null;
  cancel_requested: number;
  stage: Stage;
  status: ProjectMemoryReviewRecord["status"];
  failure_count: number;
  next_retry_at: number | null;
  error: string | null;
}

function inImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("begin immediate");
  try {
    const result = operation();
    db.exec("commit");
    return result;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

function readRow(db: DatabaseSync, workspaceKey: string): ReviewRow | undefined {
  return db
    .prepare("select * from project_memory_review where workspace_key = ?")
    .get(workspaceKey) as unknown as ReviewRow | undefined;
}

export function claimProjectMemoryReview(
  db: DatabaseSync,
  input: ProjectMemoryReviewClaimInput,
): ProjectMemoryReviewClaim {
  return inImmediateTransaction(db, () => {
    const inserted = db
      .prepare(`insert or ignore into project_memory_review (workspace_key, workspace_path, baseline_at)
      values (?, ?, ?)`)
      .run(input.workspaceKey, input.workspacePath, input.now);
    let row = readRow(db, input.workspaceKey)!;
    if (input.trigger === "automatic" && inserted.changes > 0)
      return { status: "skipped", reason: "initialized" };
    if (row.lease_until !== null && row.lease_until > input.now)
      return { status: "skipped", reason: "leased" };
    if (row.status === "running" && row.review_id) {
      // 过期与正常失败使用同一结算规则：第五次不再给重试时间，已请求取消不冒充失败。
      settleReview(db, row, {
        workspaceKey: input.workspaceKey,
        reviewId: row.review_id,
        epoch: row.epoch,
        now: input.now,
        status: "failed",
        changedFiles: JSON.parse(row.changed_files_json) as string[],
        totalTokens: row.total_tokens,
        error: row.cancel_requested === 1 ? "cancelled" : "lease expired",
      });
      row = readRow(db, input.workspaceKey)!;
    }
    if (input.trigger === "automatic") {
      if (row.status === "cancelled") return { status: "skipped", reason: "cancelled" };
      if (row.failure_count >= MAX_AUTOMATIC_FAILURES)
        return { status: "skipped", reason: "retry_exhausted" };
      if (input.now - (row.last_success_at ?? row.baseline_at) < REVIEW_INTERVAL_MS)
        return { status: "skipped", reason: "cooldown" };
      if (row.next_retry_at !== null && row.next_retry_at > input.now)
        return { status: "skipped", reason: "backoff" };
    }

    const historyScope = input.historyScope ?? "workspace";
    const referenceTime =
      input.trigger === "automatic" ? (row.last_success_at ?? row.baseline_at) : -1;
    const sessionRows = selectReviewCandidates(db, { ...input, historyScope, referenceTime });
    const requiredSessions =
      historyScope === "workspace"
        ? REQUIRED_OTHER_SESSIONS
        : historyScope === "current_session"
          ? 1
          : 0;
    // 未达门槛时把进度一并回报，界面才能说明「已变化几个会话、门槛多少」（复审 GAP-05）。
    // 候选数是达标口径的真实来源，因此进度取自这里，而不是让 UI 另算一遍。
    if (input.trigger === "automatic" && sessionRows.length < requiredSessions)
      return {
        status: "skipped",
        reason: "insufficient_sessions",
        thresholdProgress: memoryReviewThresholdProgress({
          historyScope,
          progressedSessions: sessionRows.length,
        }),
      };

    const reviewId = `review_${randomUUID()}`;
    const epoch = row.epoch + 1;
    const leaseUntil = input.now + input.leaseDurationMs;
    const sessionIds = sessionRows.map((session) => session.id);
    // 新 owner 不能继承上一轮文件/用量；候选数不是实际采集数，认领时必须从零开始。
    db.prepare(`update project_memory_review set workspace_path = ?, review_id = ?, epoch = ?, lease_until = ?,
      cancel_requested = 0, stage = 'locate', status = 'running', error = null, next_retry_at = null,
      changed_files_json = '[]', total_tokens = 0, history_scope = ?, session_count = 0, token_usage_estimated = 0,
      failure_count = case when ? = 'manual' then 0 else failure_count end where workspace_key = ?
    `).run(
      input.workspacePath,
      reviewId,
      epoch,
      leaseUntil,
      historyScope,
      input.trigger,
      input.workspaceKey,
    );
    db.prepare(`insert into project_memory_review_run
      (review_id, workspace_key, epoch, trigger, session_ids_json, status, started_at, history_scope, session_count, token_usage_estimated, stage)
      values (?, ?, ?, ?, ?, 'running', ?, ?, 0, 0, 'locate')
    `).run(
      reviewId,
      input.workspaceKey,
      epoch,
      input.trigger,
      JSON.stringify(sessionIds),
      input.now,
      historyScope,
    );
    return { status: "claimed", reviewId, epoch, sessionIds, leaseUntil };
  });
}

function progressFields(row: ReviewProgressRow) {
  return {
    historyScope: row.history_scope ?? undefined,
    sessionCount: row.session_count ?? undefined,
    tokenUsageEstimated:
      row.token_usage_estimated == null ? undefined : row.token_usage_estimated === 1,
    changedFiles: JSON.parse(row.changed_files_json) as string[],
    totalTokens: row.total_tokens,
  };
}

export function listProjectMemoryReviews(
  db: DatabaseSync,
  workspaceKey: string,
  before?: { startedAt: number; reviewId: string },
): MemoryReviewRun[] {
  const rows = db
    .prepare(`select * from project_memory_review_run where workspace_key=? and
    (started_at < ? or (started_at=? and review_id < ?)) order by started_at desc, review_id desc limit 51`)
    .all(
      workspaceKey,
      before?.startedAt ?? Number.MAX_SAFE_INTEGER,
      before?.startedAt ?? Number.MAX_SAFE_INTEGER,
      before?.reviewId ?? "",
    ) as unknown as Array<
    ReviewProgressRow & {
      review_id: string;
      trigger: "automatic" | "manual";
      session_ids_json: string;
      status: MemoryReviewRun["status"];
      started_at: number;
      finished_at: number | null;
      error: string | null;
      stage: Stage | null;
    }
  >;
  return rows.map((row) => ({
    reviewId: row.review_id,
    trigger: row.trigger,
    sessionIds: JSON.parse(row.session_ids_json) as string[],
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    stage: row.stage ?? undefined,
    ...progressFields(row),
  }));
}

export function renewProjectMemoryReview(
  db: DatabaseSync,
  input: {
    workspaceKey: string;
    reviewId: string;
    epoch: number;
    now: number;
    leaseDurationMs: number;
    stage?: Stage;
    totalTokens?: number;
    changedFiles?: string[];
    sessionCount?: number;
    tokenUsageEstimated?: boolean;
  },
): boolean {
  return inImmediateTransaction(db, () => {
    const estimated =
      input.tokenUsageEstimated === undefined ? null : Number(input.tokenUsageEstimated);
    const updated =
      db
        .prepare(`update project_memory_review set lease_until = ?, stage = coalesce(?, stage),
      total_tokens = max(total_tokens, coalesce(?, total_tokens)), changed_files_json = coalesce(?, changed_files_json),
      session_count = coalesce(?, session_count),
      token_usage_estimated = case when token_usage_estimated = 1 then 1 else coalesce(?, token_usage_estimated) end
      where workspace_key = ? and review_id = ? and epoch = ?
        and status = 'running' and lease_until > ? and cancel_requested = 0
    `)
        .run(
          input.now + input.leaseDurationMs,
          input.stage ?? null,
          input.totalTokens ?? null,
          input.changedFiles
            ? JSON.stringify(input.changedFiles.slice(0, MAX_CHANGED_FILES))
            : null,
          input.sessionCount ?? null,
          estimated,
          input.workspaceKey,
          input.reviewId,
          input.epoch,
          input.now,
        ).changes === 1;
    if (!updated) return false;
    // 原实现只更新 current，历史里的 running 用量/文件始终为零；必须在同一事务复制 owner 的真实进度。
    db.prepare(`update project_memory_review_run set
      (stage, total_tokens, changed_files_json, history_scope, session_count, token_usage_estimated) =
      (select stage, total_tokens, changed_files_json, history_scope, session_count, token_usage_estimated
        from project_memory_review where workspace_key = ?)
      where workspace_key = ? and review_id = ? and epoch = ? and status = 'running'
    `).run(input.workspaceKey, input.workspaceKey, input.reviewId, input.epoch);
    return true;
  });
}

/** 提交点复核整理租约：调用方持共用协调屏障，reviewId/epoch 必须仍有效且未取消。 */
export function assertProjectMemoryReviewFence(
  db: DatabaseSync,
  input: {
    workspaceKey: string;
    reviewId: string;
    epoch: number;
    now: number;
  },
): void {
  const row = db
    .prepare(`select 1 from project_memory_review
    where workspace_key = ? and review_id = ? and epoch = ?
      and status = 'running' and lease_until > ? and cancel_requested = 0`)
    .get(input.workspaceKey, input.reviewId, input.epoch, input.now);
  if (!row) throw new Error("Project memory review lease was lost before commit");
}

export function requestCancelProjectMemoryReview(
  db: DatabaseSync,
  input: { workspaceKey: string; reviewId: string },
): boolean {
  return (
    db
      .prepare(`update project_memory_review set cancel_requested = 1
    where workspace_key = ? and review_id = ? and status = 'running'
  `)
      .run(input.workspaceKey, input.reviewId).changes === 1
  );
}

export function finishProjectMemoryReview(
  db: DatabaseSync,
  input: ProjectMemoryReviewFinishInput,
): "completed" | "failed" | "cancelled" | "stale" {
  return inImmediateTransaction(db, () => {
    const row = readRow(db, input.workspaceKey);
    if (
      !row ||
      row.review_id !== input.reviewId ||
      row.epoch !== input.epoch ||
      row.status !== "running" ||
      row.lease_until === null ||
      row.lease_until <= input.now
    )
      return "stale";
    return settleReview(db, row, input);
  });
}

/**
 * 收口 owner 已失效（租约过期）的整理，返回是否发生了结算。
 *
 * 修复原因：过期的 running 整理只在下一次 claim 时才结算；进程死亡后，状态读取与取消长期显示 running（复审 DEF-17）。
 * 依据：与 claim 使用同一结算规则（过期按失败计次，已请求取消的按取消），这样状态读取、取消与再次认领得到一致的终态。
 * 只能在外部协调屏障内调用。
 */
export function reapExpiredProjectMemoryReview(
  db: DatabaseSync,
  workspaceKey: string,
  now: number,
): boolean {
  return inImmediateTransaction(db, () => {
    const row = readRow(db, workspaceKey);
    if (!row || row.status !== "running" || !row.review_id) return false;
    if (row.lease_until !== null && row.lease_until > now) return false;
    settleReview(db, row, {
      workspaceKey,
      reviewId: row.review_id,
      epoch: row.epoch,
      now,
      status: "failed",
      changedFiles: JSON.parse(row.changed_files_json) as string[],
      totalTokens: row.total_tokens,
      error: row.cancel_requested === 1 ? "cancelled" : "lease expired",
    });
    return true;
  });
}

/** 正常结束和过期回收共用结算；只能在既有事务及外部协调屏障内调用。 */
function settleReview(
  db: DatabaseSync,
  row: ReviewRow,
  input: ProjectMemoryReviewFinishInput,
): "completed" | "failed" | "cancelled" {
  const status = row.cancel_requested === 1 ? "cancelled" : input.status;
  // 取消保留原计数；手动重启在 claim 清零；过期和普通失败均最多五次。
  const failureCount =
    status === "completed"
      ? 0
      : status === "cancelled"
        ? row.failure_count
        : Math.min(row.failure_count + 1, MAX_AUTOMATIC_FAILURES);
  const nextRetryAt =
    status === "failed" && failureCount < MAX_AUTOMATIC_FAILURES
      ? input.now + Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.max(0, failureCount - 1))
      : null;
  const files = JSON.stringify(input.changedFiles.slice(0, MAX_CHANGED_FILES));
  const tokens = Math.max(row.total_tokens, input.totalTokens);
  const count = input.sessionCount ?? row.session_count;
  const estimated =
    row.token_usage_estimated === 1 || input.tokenUsageEstimated === true
      ? 1
      : input.tokenUsageEstimated === false
        ? 0
        : row.token_usage_estimated;
  const error = input.error?.slice(0, MAX_ERROR_CHARS) ?? null;
  db.prepare(`update project_memory_review set
    review_id = null, lease_until = null, cancel_requested = 0, stage = 'idle', status = ?,
    last_success_at = case when ? = 'completed' then ? else last_success_at end,
    failure_count = ?, next_retry_at = ?, changed_files_json = ?, total_tokens = ?, error = ?, session_count = ?, token_usage_estimated = ?
    where workspace_key = ? and review_id = ? and epoch = ?
  `).run(
    status,
    status,
    input.now,
    failureCount,
    nextRetryAt,
    files,
    tokens,
    error,
    count,
    estimated,
    input.workspaceKey,
    input.reviewId,
    input.epoch,
  );
  db.prepare(`update project_memory_review_run set
    status = ?, finished_at = ?, changed_files_json = ?, total_tokens = ?, error = ?, stage = ?,
    history_scope = ?, session_count = ?, token_usage_estimated = ? where workspace_key = ? and review_id = ? and epoch = ?
  `).run(
    status,
    input.now,
    files,
    tokens,
    error,
    row.stage,
    row.history_scope,
    count,
    estimated,
    input.workspaceKey,
    input.reviewId,
    input.epoch,
  );
  return status;
}

export function getProjectMemoryReview(
  db: DatabaseSync,
  workspaceKey: string,
): ProjectMemoryReviewRecord | null {
  const row = readRow(db, workspaceKey);
  if (!row) return null;
  return {
    workspaceKey,
    lastSuccessAt: row.last_success_at ?? undefined,
    reviewId: row.review_id ?? undefined,
    epoch: row.epoch,
    leaseUntil: row.lease_until ?? undefined,
    cancelRequested: row.cancel_requested === 1,
    stage: row.stage,
    status: row.status,
    nextRetryAt: row.next_retry_at ?? undefined,
    error: row.error ?? undefined,
    failureCount: row.failure_count,
    automaticRetryExhausted: row.failure_count >= MAX_AUTOMATIC_FAILURES,
    ...progressFields(row),
  };
}
