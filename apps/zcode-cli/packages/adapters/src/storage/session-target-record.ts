// Modified by ZCode Feiyu.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SessionId, SessionGoal, GoalStatus } from "@zcode/contracts";

export interface TargetRow {
  session_id: string;
  target_id: string;
  objective: string;
  summary_title: string | null;
  status: string;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  active_input_id: string | null;
  active_run_started_at: number | null;
  active_run_last_seen_at: number | null;
  time_created: number;
  time_updated: number;
}

export function readSessionTarget(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): SessionGoal | null {
  const row = db
    .prepare("select * from session_target where session_id = ?")
    .get(input.sessionID) as TargetRow | undefined;
  return row ? decodeTargetRow(row) : null;
}

export function mustReadTarget(db: DatabaseSync, sessionID: SessionId): SessionGoal {
  const target = readSessionTarget(db, { sessionID });
  if (!target) {
    throw new Error(`Session target not found after write: ${sessionID}`);
  }
  return target;
}

export function touchSessionForTarget(
  db: DatabaseSync,
  sessionID: SessionId,
  timeUpdated: number,
): void {
  db.prepare("update session set time_updated = max(time_updated, ?) where id = ?").run(
    timeUpdated,
    sessionID,
  );
}

export function decodeTargetRow(row: TargetRow): SessionGoal {
  return {
    sessionID: row.session_id as SessionId,
    targetID: row.target_id,
    objective: row.objective,
    summaryTitle: row.summary_title,
    status: currentGoalStatus(row.status as GoalStatus),
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    activeInputId: row.active_input_id,
    activeRunStartedAtMs: row.active_run_started_at,
    activeRunLastSeenAtMs: row.active_run_last_seen_at,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  };
}

export function createStorageTargetId(): string {
  return `target_${Date.now().toString(36)}_${randomUUID()}`;
}

export // 老额度暂停不再是执行状态；只映射该历史值，用户暂停/完成及崩溃恢复仍走原来的状态边界。
function currentGoalStatus(status: GoalStatus): GoalStatus {
  return status === "budget_limited" ? "active" : status;
}

export function elapsedSecondsBetween(startedAtMs: number, endedAtMs: number): number {
  return Math.max(0, Math.ceil((endedAtMs - startedAtMs) / 1000));
}
