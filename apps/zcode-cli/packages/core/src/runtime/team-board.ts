// Modified by ZCode Feiyu contributors (2026).
import {
  SESSION_ENTRY_TEAM_BOARD,
  TeamBoardStateSchema,
  type SessionId,
  type SessionStorePort,
  type TeamBoardPort,
  type TeamBoardState,
  type TeamBoardTask,
  type TeamTaskInput,
} from "@zcode/contracts";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";

const EMPTY_BOARD: TeamBoardState = { branchGeneration: 0, revision: 0, tasks: [] };
const MAX_TEAM_TASKS = 64;
const STALE_BRANCH_ERROR = "Team member belongs to a different conversation branch";

export function createTeamBoardPort(
  sessionId: SessionId,
  store: SessionStorePort,
  registry: RuntimeTaskRegistry,
  onChange?: (state: TeamBoardState) => Promise<void>,
  getBranchGeneration: () => number = () => 0,
): TeamBoardPort {
  let loaded: TeamBoardState | undefined;
  let publishedRevision = 0;
  let pending: Promise<void> = Promise.resolve();
  const read = async (): Promise<TeamBoardState> => {
    if (loaded?.branchGeneration === getBranchGeneration()) return loaded;
    if (!store.sessionEntries || !store.saveSessionEntry) {
      throw new Error("Team task storage is unavailable");
    }
    if (!loaded) {
      const entries = await store.sessionEntries({
        sessionID: sessionId,
        type: SESSION_ENTRY_TEAM_BOARD,
      });
      const parsed = TeamBoardStateSchema.safeParse(entries.at(-1)?.data);
      loaded = parsed.success ? parsed.data : EMPTY_BOARD;
    }
    if (loaded.branchGeneration !== getBranchGeneration()) {
      return persist({
        branchGeneration: getBranchGeneration(),
        revision: loaded.revision + 1,
        tasks: [],
      });
    }
    return loaded;
  };
  const resolveMember = (name: string): string => {
    const normalized = name.normalize("NFKC").toLowerCase();
    const member = Object.values(registry.all()).find(
      (task) =>
        task.type === "local_agent" &&
        task.parentSessionId === sessionId &&
        task.branchGeneration === getBranchGeneration() &&
        Boolean(task.teamMemberName) &&
        (task.agentId === name ||
          task.teamMemberName?.normalize("NFKC").toLowerCase() === normalized),
    );
    if (!member) throw new Error(`Team member ${name} is unavailable`);
    return member.agentId;
  };
  const assertActor = (actorId: string, branchGeneration: number, runId?: string): void => {
    if (branchGeneration !== getBranchGeneration()) throw new Error(STALE_BRANCH_ERROR);
    if (actorId === "coordinator") return;
    const actor = registry.get(actorId);
    if (actor?.branchGeneration !== branchGeneration) throw new Error(STALE_BRANCH_ERROR);
    if (
      actor.type !== "local_agent" ||
      actor.parentSessionId !== sessionId ||
      !actor.teamMemberName ||
      actor.status !== "running" ||
      actor.traceContext?.spanId !== runId
    ) {
      throw new Error("Team member is not active in this session");
    }
  };
  const persist = async (state: TeamBoardState): Promise<TeamBoardState> => {
    const now = Date.now();
    await store.saveSessionEntry!({
      id: `${sessionId}:team-board`,
      sessionID: sessionId,
      type: SESSION_ENTRY_TEAM_BOARD,
      touchSession: false,
      time: { created: now, updated: now },
      data: state,
    });
    loaded = state;
    // 保存等待期间可能撤回；旧板仅留历史，先发布更高 revision 的当前空板。
    if (state.branchGeneration !== getBranchGeneration()) return read();
    await publish(state);
    return state;
  };
  const publish = async (state: TeamBoardState): Promise<void> => {
    if (!onChange || state.revision <= publishedRevision) return;
    await onChange(state);
    publishedRevision = state.revision;
  };
  return {
    execute(input, actorId) {
      // 固定调用的出生身份，排队或读库之后不能用新分支/新运行重新授权旧请求。
      const branchGeneration = getBranchGeneration();
      const runId = registry.get(actorId)?.traceContext?.spanId;
      const work = pending.then(async () => {
        assertActor(actorId, branchGeneration, runId);
        const current = await read();
        assertActor(actorId, branchGeneration, runId);
        if (input.action === "list") {
          await publish(current);
          assertActor(actorId, branchGeneration, runId);
          return current;
        }
        const tasks = [...current.tasks];
        const now = Date.now();
        if (input.action === "create") {
          if (tasks.length >= MAX_TEAM_TASKS) {
            throw new Error(`Team task board is full (${MAX_TEAM_TASKS} tasks)`);
          }
          tasks.push({
            id: `team_${crypto.randomUUID()}`,
            description: input.description,
            status: "pending",
            createdAt: now,
            updatedAt: now,
          });
        } else {
          const index = tasks.findIndex((task) => task.id === input.taskId);
          if (index < 0) throw new Error(`Team task ${input.taskId} was not found`);
          const task = tasks[index];
          tasks[index] = updateTask(
            task,
            input,
            actorId,
            resolveMember,
            (agentId) => registry.get(agentId)?.teamMemberName,
            now,
          );
        }
        const saved = await persist({
          branchGeneration: current.branchGeneration,
          revision: current.revision + 1,
          tasks,
        });
        assertActor(actorId, branchGeneration, runId);
        return saved;
      });
      pending = work.then(
        () => undefined,
        () => undefined,
      );
      return work;
    },
  };
}

function updateTask(
  task: TeamBoardTask,
  input: Exclude<TeamTaskInput, { action: "list" | "create" }>,
  actorId: string,
  resolveMember: (name: string) => string,
  memberName: (agentId: string) => string | undefined,
  now: number,
): TeamBoardTask {
  if (task.status === "completed" || task.status === "cancelled") {
    throw new Error(`Team task ${task.id} is already ${task.status}`);
  }
  switch (input.action) {
    case "claim":
      if (task.assigneeId && task.assigneeId !== actorId) {
        throw new Error(`Team task ${task.id} is assigned to another member`);
      }
      return {
        ...task,
        assigneeId: actorId,
        assigneeName: memberName(actorId),
        status: "in_progress",
        updatedAt: now,
      };
    case "assign":
      if (actorId !== "coordinator") throw new Error("Only the coordinator can assign tasks");
      return {
        ...task,
        assigneeId: resolveMember(input.member),
        assigneeName: input.member,
        status: "pending",
        updatedAt: now,
      };
    case "complete":
      if (actorId !== "coordinator" && task.assigneeId !== actorId) {
        throw new Error("Only the assignee or coordinator can complete this task");
      }
      return {
        ...task,
        status: "completed",
        updatedAt: now,
        ...(input.result ? { result: input.result } : {}),
      };
    case "cancel":
      if (actorId !== "coordinator") throw new Error("Only the coordinator can cancel tasks");
      return { ...task, status: "cancelled", updatedAt: now };
  }
}
