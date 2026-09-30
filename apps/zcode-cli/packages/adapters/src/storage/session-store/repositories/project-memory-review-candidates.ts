// Modified by ZCode Feiyu contributors (2026).
import type { DatabaseSync } from "node:sqlite";
import {
  isTaskRoot,
  SESSION_TASK_ROOT_TYPES,
  type SessionId,
  type SessionTaskType,
} from "@zcode/contracts";
import { memoryReviewThresholdProgress, type MemoryReviewThresholdProgress } from "@zcode/shared";
const MAX_HISTORY_SESSIONS = 10;
/**
 * 门槛候选会话的唯一口径。
 *
 * fork 的 parent_id 是来源而不是 child 标志；SQL 共享顶层类型，workspace 范围显式保留
 * 既有 side-chat 历史范围。认领与只读门槛进度共用这里，避免两处口径漂移（复审 GAP-05）。
 */
export function selectReviewCandidates(
  db: DatabaseSync,
  input: {
    workspaceKey: string;
    workspacePath: string;
    currentSessionId: SessionId;
    historyScope: "workspace" | "current_session" | "none";
    referenceTime: number;
  },
): { id: SessionId }[] {
  const taskTypes =
    input.historyScope === "current_session"
      ? SESSION_TASK_ROOT_TYPES
      : [...SESSION_TASK_ROOT_TYPES, "selection_side_chat"];
  const candidates =
    input.historyScope === "none"
      ? []
      : (db
          .prepare(
            `select id, task_type, parent_id from session
      where (workspace_id = ? or (workspace_id is null and directory = ?))
        and id ${input.historyScope === "current_session" ? "=" : "<>"} ? and time_updated > ?
        and task_type in (${taskTypes.map(() => "?").join(", ")})
      order by time_updated desc, id desc limit ?`,
          )
          .all(
            input.workspaceKey,
            input.workspacePath,
            input.currentSessionId,
            input.referenceTime,
            ...taskTypes,
            input.historyScope === "current_session" ? 1 : MAX_HISTORY_SESSIONS,
          ) as unknown as {
          id: SessionId;
          task_type: SessionTaskType;
          parent_id: string | null;
        }[]);
  return input.historyScope === "current_session"
    ? candidates.filter((session) => isTaskRoot(session.task_type, session.parent_id))
    : candidates;
}

/** 只读门槛进度：与认领使用同一候选口径，因此界面显示的数字就是准入判定用的数字。 */
export function readProjectMemoryReviewThreshold(
  db: DatabaseSync,
  input: {
    workspaceKey: string;
    workspacePath: string;
    currentSessionId: SessionId;
    historyScope: "workspace" | "current_session" | "none";
    now: number;
  },
): MemoryReviewThresholdProgress {
  const row = db
    .prepare("select last_success_at,baseline_at from project_memory_review where workspace_key=?")
    .get(input.workspaceKey) as { last_success_at: number | null; baseline_at: number } | undefined;
  // 没有任何整理记录时以「现在」为基准：候选数为 0，进度从零开始展示，不谎称已积累。
  const referenceTime = row ? (row.last_success_at ?? row.baseline_at) : input.now;
  const sessionRows = selectReviewCandidates(db, { ...input, referenceTime });
  return memoryReviewThresholdProgress({
    historyScope: input.historyScope,
    progressedSessions: sessionRows.length,
  });
}
