// Modified by ZCode Feiyu contributors (2026).
import type { DatabaseSync } from "node:sqlite";
import { SESSION_ENTRY_ORCHESTRATION_STATE, SESSION_TASK_ROOT_TYPES } from "@zcode/contracts";
import {
  orchestrationStateSchema,
  resumeRetiredExecutionPause,
} from "@zcode/shared/zcode-protocol-v4";

/** 无结构迁移：原会话事实在同一事务升级并作废旧代触发，不重放已消费输入。 */
export function resumeRetiredProactiveWorkspace(
  db: DatabaseSync,
  workspaceKey: string,
  now: number,
  activeSessionIds: readonly string[] = [],
): void {
  db.exec("begin immediate");
  try {
    const active = new Set(activeSessionIds);
    const rows = db
      .prepare(`select e.id,e.session_id,e.data from session_entry e join session s on s.id=e.session_id
      where e.type=? and coalesce(nullif(trim(s.workspace_id),''),s.directory)=? and s.time_archived is null
      and (s.task_type in (select value from json_each(?)) or (s.task_type is null and s.parent_id is null))
      and json_extract(e.data,'$.proactive.status')='paused'`)
      .all(
        SESSION_ENTRY_ORCHESTRATION_STATE,
        workspaceKey,
        JSON.stringify(SESSION_TASK_ROOT_TYPES),
      ) as { id: string; session_id: string; data: string }[];
    for (const row of rows) {
      if (active.has(row.session_id)) continue;
      const parsed = orchestrationStateSchema.safeParse(JSON.parse(row.data));
      if (!parsed.success) continue;
      const next = resumeRetiredExecutionPause(parsed.data, true);
      if (next === parsed.data) continue;
      db.prepare("update session_entry set data=?,time_updated=? where id=? and data=?").run(
        JSON.stringify(next),
        now,
        row.id,
        row.data,
      );
      db.prepare(`update proactive_trigger set state='rejected',error='retired_execution_limit',owner_id=null,lease_until=null,updated_at=?
        where target_session_id=? and generation<? and state in ('pending','dispatching')`).run(
        now,
        row.session_id,
        next.proactive!.generation,
      );
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
