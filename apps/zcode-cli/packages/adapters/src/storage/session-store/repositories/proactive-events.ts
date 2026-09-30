// Modified by ZCode Feiyu contributors (2026).
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isTaskRoot,
  SESSION_TASK_ROOT_TYPES,
  SESSION_ENTRY_ORCHESTRATION_STATE,
  type SessionStorePort,
  type SessionTaskType,
} from "@zcode/contracts";
import {
  MAX_PROACTIVE_CAUSAL_DEPTH,
  orchestrationStateSchema,
  proactiveCausalContextSchema,
} from "@zcode/shared/zcode-protocol-v4";
type StoreInput<K extends keyof SessionStorePort> = Parameters<
  Extract<SessionStorePort[K], (...args: never[]) => unknown>
>[0];
type Trigger = {
  trigger_id: string;
  source_session_id: string;
  target_session_id: string;
  command_id: string;
  prompt: string;
  generation: number;
  depth: number;
  state: "pending" | "dispatching" | "delivered" | "rejected";
};
/** 单个触发的最大派发次数；超过后转终态 rejected，不再无限退避重试。 */
export const PROACTIVE_TRIGGER_MAX_ATTEMPTS = 8;

export function publishProactiveEvent(
  db: DatabaseSync,
  input: StoreInput<"publishProactiveEvent">,
): void {
  if (
    !input.eventId.trim() ||
    !input.workspaceKey.trim() ||
    !input.sourceSessionId.trim() ||
    !input.sourceId.trim() ||
    !Number.isFinite(input.now)
  )
    throw new Error("Invalid proactive source identity");
  if (!Number.isInteger(input.depth) || input.depth < 0)
    throw new Error("Invalid proactive causal depth");
  if (input.depth >= MAX_PROACTIVE_CAUSAL_DEPTH) return;
  db.exec("begin immediate");
  try {
    const source = db
      .prepare("select workspace_id,directory,parent_id,task_type from session where id=?")
      .get(input.sourceSessionId) as
      | {
          workspace_id: string | null;
          directory: string;
          parent_id: string | null;
          task_type?: SessionTaskType;
        }
      | undefined;
    if (
      !source ||
      !isTaskRoot(source.task_type, source.parent_id) ||
      (source.workspace_id?.trim() || source.directory) !== input.workspaceKey
    ) {
      db.exec("commit");
      return;
    }
    const inserted = db
      .prepare("insert or ignore into proactive_event values (?,?,?,?,?,?,?)")
      .run(
        input.eventId,
        input.workspaceKey,
        input.sourceSessionId,
        input.sourceId,
        input.kind,
        input.depth,
        input.now,
      );
    if (!inserted.changes) {
      db.exec("commit");
      return;
    }
    if (input.lifecycle) {
      const expected =
        input.kind === "automation_due"
          ? "turn_started"
          : input.kind === "task_completed"
            ? "turn_complete"
            : input.kind === "task_failed"
              ? "turn_error"
              : null;
      if (
        input.lifecycle.type !== expected ||
        !input.lifecycle.eventId.trim() ||
        !input.lifecycle.commandId.trim()
      )
        throw new Error("Invalid proactive source lifecycle");
      // 同一事务保存确认所依据的源事实；没有 pending/outbox 第二队列，重启直接 claim 已有 trigger。
      db.prepare(
        "insert into session_entry(id,session_id,type,time_created,time_updated,data) values (?,?,?,?,?,?)",
      ).run(
        `proactive-source:${input.eventId}`,
        input.sourceSessionId,
        "runtime/proactive_source",
        input.now,
        input.now,
        JSON.stringify({
          eventId: input.eventId,
          workspaceKey: input.workspaceKey,
          sourceSessionId: input.sourceSessionId,
          sourceId: input.sourceId,
          kind: input.kind,
          depth: input.depth,
          at: input.now,
          lifecycle: input.lifecycle,
        }),
      );
    }
    const targets = db
      .prepare(`select e.session_id,e.data from session_entry e join session s on s.id=e.session_id
      where e.type=? and coalesce(nullif(trim(s.workspace_id),''),s.directory)=?
      and (s.task_type in (select value from json_each(?)) or (s.task_type is null and s.parent_id is null))
      and s.time_archived is null and e.session_id<>?`)
      .all(
        SESSION_ENTRY_ORCHESTRATION_STATE,
        input.workspaceKey,
        JSON.stringify(SESSION_TASK_ROOT_TYPES),
        input.sourceSessionId,
      ) as { session_id: string; data: string }[];
    for (const target of targets) {
      if (input.targetSessionId && target.session_id !== input.targetSessionId) continue;
      const parsed = orchestrationStateSchema.safeParse(JSON.parse(target.data));
      const state = parsed.success ? parsed.data.proactive : undefined;
      if (state?.status !== "running") continue;
      for (const subscription of state.subscriptions) {
        if (subscription.event !== input.kind || subscription.sourceId !== input.sourceId) continue;
        const triggerId = createHash("sha256")
          .update(
            JSON.stringify([input.eventId, target.session_id, subscription.id, state.generation]),
          )
          .digest("hex");
        const commandId = `task-app:${input.sourceSessionId}:proactive:${triggerId}`;
        db.prepare(`insert or ignore into proactive_trigger (trigger_id,event_id,workspace_key,source_session_id,target_session_id,command_id,prompt,generation,depth,state,updated_at)
          values (?,?,?,?,?,?,?,?,?,'pending',?)`).run(
          triggerId,
          input.eventId,
          input.workspaceKey,
          input.sourceSessionId,
          target.session_id,
          commandId,
          subscription.prompt,
          state.generation,
          input.depth + 1,
          input.now,
        );
      }
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
export function listProactiveMailboxTargets(db: DatabaseSync, workspaceKey: string): string[] {
  const rows = db
    .prepare(`select distinct e.session_id from session_entry e join session s on s.id=e.session_id,
    json_each(e.data,'$.proactive.subscriptions') subscription
    where e.type=? and coalesce(nullif(trim(s.workspace_id),''),s.directory)=? and s.time_archived is null
      and (s.task_type in (select value from json_each(?)) or (s.task_type is null and s.parent_id is null))
      and json_extract(e.data,'$.proactive.status')='running' and json_extract(subscription.value,'$.event')='mailbox_message'`)
    .all(
      SESSION_ENTRY_ORCHESTRATION_STATE,
      workspaceKey,
      JSON.stringify(SESSION_TASK_ROOT_TYPES),
    ) as { session_id: string }[];
  return rows.map((row) => row.session_id);
}
export function claimProactiveTriggers(
  db: DatabaseSync,
  workspaceKey: string,
  ownerId: string,
  now: number,
) {
  db.exec("begin immediate");
  try {
    // generation/status 是认领前的持久屏障，不能派发已暂停但尚未被 runtime 清扫的旧事实。
    db.prepare(`update proactive_trigger set state='rejected',error='Proactive event was stopped or superseded',owner_id=null,lease_until=null,updated_at=?
      where workspace_key=? and state in ('pending','dispatching') and not exists
        (select 1 from session_entry e where e.session_id=proactive_trigger.target_session_id and e.type=?
          and json_extract(e.data,'$.proactive.status')='running' and json_extract(e.data,'$.proactive.generation')=proactive_trigger.generation)`).run(
      now,
      workspaceKey,
      SESSION_ENTRY_ORCHESTRATION_STATE,
    );
    // 修复：原实现的 attempts 没有上限，持续失败的触发会以 5 分钟退避永久重试；达到上限后直接结算为 rejected。
    db.prepare(`update proactive_trigger set state='rejected',error=coalesce(error,'Proactive trigger retry limit reached'),owner_id=null,lease_until=null,updated_at=?
      where workspace_key=? and attempts>=? and ((state='pending' and retry_at<=?) or (state='dispatching' and lease_until<=?))`).run(
      now,
      workspaceKey,
      PROACTIVE_TRIGGER_MAX_ATTEMPTS,
      now,
      now,
    );
    const rows = db
      .prepare(
        `select * from proactive_trigger where workspace_key=? and ((state='pending' and retry_at<=?) or (state='dispatching' and lease_until<=?)) order by updated_at limit 1`,
      )
      .all(workspaceKey, now, now) as unknown as Trigger[];
    for (const row of rows)
      db.prepare(
        "update proactive_trigger set state='dispatching',owner_id=?,lease_until=?,attempts=attempts+1,updated_at=? where trigger_id=?",
      ).run(ownerId, now + 60_000, now, row.trigger_id);
    db.exec("commit");
    return rows.map((row) => ({
      triggerId: row.trigger_id,
      sourceSessionId: row.source_session_id,
      targetSessionId: row.target_session_id,
      commandId: row.command_id,
      prompt: row.prompt,
      generation: row.generation,
      depth: row.depth,
    }));
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
export function settleProactiveTrigger(
  db: DatabaseSync,
  input: StoreInput<"settleProactiveTrigger">,
): void {
  db.prepare(`update proactive_trigger set state=case when ?='pending' and attempts>=? then 'rejected' else ? end,
    error=case when ?='pending' and attempts>=? then 'Proactive trigger retry limit reached' else ? end,
    owner_id=null,lease_until=null,updated_at=?,retry_at=?+min(300000,5000*attempts)
    where trigger_id=? and owner_id=? and state='dispatching'`).run(
    input.status,
    PROACTIVE_TRIGGER_MAX_ATTEMPTS,
    input.status,
    input.status,
    PROACTIVE_TRIGGER_MAX_ATTEMPTS,
    input.error?.slice(0, 500) ?? null,
    input.now,
    input.now,
    input.triggerId,
    input.ownerId,
  );
}
export function readProactiveTrigger(db: DatabaseSync, commandId: string) {
  const row = db.prepare("select * from proactive_trigger where command_id=?").get(commandId) as
    | Trigger
    | undefined;
  return row
    ? {
        targetSessionId: row.target_session_id,
        generation: row.generation,
        depth: row.depth,
        state: row.state,
      }
    : null;
}
/** 时间窗口既会污染独立用户输入，也会放过长任务；必须读取原已提升输入的因果事实。 */
export function proactiveDepthForSource(
  db: DatabaseSync,
  sourceSessionId: string,
  commandId: string,
): number | null {
  const row = db
    .prepare(`select payload from session_input where session_id=? and status='promoted'
    and (id=? or json_extract(payload,'$.intent.sourceCommandId')=? or json_extract(payload,'$.conversationInputIntent.sourceCommandId')=?) limit 1`)
    .get(sourceSessionId, commandId, commandId, commandId) as { payload: string } | undefined;
  if (!row) return null;
  const payload = JSON.parse(row.payload);
  const context = proactiveCausalContextSchema.safeParse(
    payload.causalContext ?? (payload.conversationInputIntent ?? payload.intent)?.causalContext,
  );
  const trigger = readProactiveTrigger(db, commandId);
  if (trigger && trigger.targetSessionId !== sourceSessionId) return null;
  return Math.max(trigger?.depth ?? 0, context.success ? context.data.depth : 0);
}
export function mergeProactiveInputCause(
  db: DatabaseSync,
  sessionId: string,
  cause: import("@zcode/shared/zcode-protocol-v4").ProactiveCausalContext,
): void {
  const valid = proactiveCausalContextSchema.parse(cause);
  // 仍写原输入 JSON，深度只增不减；不是接受新输入的第二条入口。
  db.prepare(`update session_input set payload=json_set(payload,'$.causalContext',json(?))
    where session_id=? and status='promoted' and
      (id=? or json_extract(payload,'$.intent.sourceCommandId')=? or json_extract(payload,'$.conversationInputIntent.sourceCommandId')=?)
      and coalesce(json_extract(payload,'$.causalContext.depth'),-1)<=?`).run(
    JSON.stringify(valid),
    sessionId,
    valid.sourceCommandId,
    valid.sourceCommandId,
    valid.sourceCommandId,
    valid.depth,
  );
}

/** 认领中的旧代也必须终结；迟到网络回执只能更新仍持有 claim 的记录，不能复活已撤销输入。 */
export function rejectSupersededProactiveTriggers(
  db: DatabaseSync,
  targetSessionId: string,
  generation: number,
  reason: string,
  now: number,
): number {
  return Number(
    db
      .prepare(`update proactive_trigger set state='rejected',error=?,owner_id=null,lease_until=null,updated_at=?
    where target_session_id=? and generation<? and state in ('pending','dispatching')`)
      .run(reason.slice(0, 500), now, targetSessionId, generation).changes,
  );
}
export function pauseProactiveWorkspace(
  db: DatabaseSync,
  workspaceKey: string,
  reason: string,
  activeSessionIds: readonly string[] = [],
): void {
  db.exec("begin immediate");
  try {
    const now = Date.now();
    const excluded = JSON.stringify(activeSessionIds);
    db.prepare(`update session_entry set data=json_set(data,'$.proactive.status','paused','$.proactive.reason',?,
      '$.proactive.generation',coalesce(json_extract(data,'$.proactive.generation'),0)+1,'$.revision',coalesce(json_extract(data,'$.revision'),0)+1),time_updated=?
      where type=? and json_extract(data,'$.proactive.status')='running' and session_id not in (select value from json_each(?)) and session_id in
        (select id from session where coalesce(nullif(trim(workspace_id),''),directory)=?)`).run(
      reason,
      now,
      SESSION_ENTRY_ORCHESTRATION_STATE,
      excluded,
      workspaceKey,
    );
    db.prepare(`update proactive_trigger set state='rejected',error=?,owner_id=null,lease_until=null,updated_at=?
      where workspace_key=? and target_session_id not in (select value from json_each(?)) and state in ('pending','dispatching')`).run(
      reason,
      now,
      workspaceKey,
      excluded,
    );
    // 冷会话没有 live queue owner；仍须把原已接受未提升输入终结，不能等恢复才显示旧任务。
    db.prepare(`update session_input set status='cancelled',status_reason=?,time_updated=? where status='admitted'
      and session_id not in (select value from json_each(?)) and exists
        (select 1 from proactive_trigger t where t.workspace_key=? and t.target_session_id=session_input.session_id and exists
          (select 1 from session_entry e where e.session_id=t.target_session_id and e.type='runtime/orchestration_state'
            and json_extract(e.data,'$.proactive.generation')>t.generation)
          and (session_input.id=t.command_id or session_input.id='queue_'||t.command_id
            or json_extract(session_input.payload,'$.intent.sourceCommandId')=t.command_id
            or json_extract(session_input.payload,'$.conversationInputIntent.sourceCommandId')=t.command_id))`).run(
      reason,
      now,
      excluded,
      workspaceKey,
    );
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
