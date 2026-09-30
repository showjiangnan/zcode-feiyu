// Modified by ZCode Feiyu contributors (2026).
import {
  SESSION_ENTRY_TEAM_MEMBER,
  SessionEventType,
  type SessionEvent,
  type SessionId,
  type SessionStorePort,
} from "@zcode/contracts";
import type { RuntimeTaskRegistry, RuntimeTaskSnapshot } from "../runtime-task/registry.js";
import { restoreLocalAgentsFromEvents } from "./restore-local-agents.js";

interface MemberOwner {
  sessionId: SessionId;
  branchGeneration: number;
  sessionStore?: SessionStorePort;
  runtimeTaskRegistry: RuntimeTaskRegistry;
}
interface MemberState {
  agentId: string;
  agentType: string;
  childSessionId: SessionId;
  teamMemberName?: string;
  description: string;
  parentToolCallId?: string;
  outputFile?: string;
  background: boolean;
  branchGeneration: number;
  runId?: string;
  traceId: SessionEvent["traceId"];
  startedAt: number;
  updatedAt: number;
  status: RuntimeTaskSnapshot["status"];
  error?: string;
}

const STATUSES = new Set([
  "running",
  "completed",
  "failed",
  "cancelled",
  "killed",
  "stopped",
  "lost",
]);
// 仅串行化同一父 runtime 的现有成员事实写入，不保存第二份成员状态。
const writes = new WeakMap<MemberOwner, Promise<void>>();

export function persistTeamMemberEvent(owner: MemberOwner, event: SessionEvent): Promise<boolean> {
  if (
    event.type !== SessionEventType.SubagentSpawned &&
    event.type !== SessionEventType.SubagentStopped
  ) {
    return Promise.resolve(true);
  }
  const work = (writes.get(owner) ?? Promise.resolve()).then(async () => {
    const payload = event.payload as {
      agentId?: string;
      branchGeneration?: number;
      runId?: string;
      status?: string;
    };
    const task = payload.agentId ? owner.runtimeTaskRegistry.get(payload.agentId) : undefined;
    const isCurrent = () => {
      const current = task && owner.runtimeTaskRegistry.get(task.taskId);
      return Boolean(
        current &&
        event.sessionId === owner.sessionId &&
        current.parentSessionId === owner.sessionId &&
        current.branchGeneration === owner.branchGeneration &&
        current.branchGeneration === (payload.branchGeneration ?? 0) &&
        current.childSessionId === task?.childSessionId &&
        current.traceContext?.spanId === payload.runId,
      );
    };
    if (!task || !task.childSessionId || !isCurrent()) return false;
    const store = owner.sessionStore;
    if (!store?.saveSessionEntry || !store.sessionEntries) {
      if (task.teamMemberName) throw new Error("Durable team member storage is unavailable");
      return true;
    }
    const id = `${owner.sessionId}:team-member:${task.agentId}`;
    const previous = (
      await store.sessionEntries({ sessionID: owner.sessionId, type: SESSION_ENTRY_TEAM_MEMBER })
    ).find((entry) => entry.id === id);
    if (!isCurrent()) return false;
    const saved = previous ? parseState(previous.data) : undefined;
    // 终态只能收口同一真实运行；等待读库期间发生新 spawn 也不能回写旧 run。
    if (event.type === SessionEventType.SubagentStopped && saved && saved.runId !== payload.runId)
      return false;
    const now = event.timestamp.getTime();
    const state: MemberState = {
      agentId: task.agentId,
      agentType: task.agentType,
      childSessionId: task.childSessionId,
      ...(task.teamMemberName ? { teamMemberName: task.teamMemberName } : {}),
      description: task.description,
      ...(task.parentToolCallId ? { parentToolCallId: String(task.parentToolCallId) } : {}),
      ...(task.outputFile ? { outputFile: task.outputFile } : {}),
      background: task.isBackgrounded === true,
      branchGeneration: task.branchGeneration ?? 0,
      ...(payload.runId ? { runId: payload.runId } : {}),
      traceId: event.traceId,
      startedAt: task.startedAt.getTime(),
      updatedAt: now,
      status:
        payload.status && STATUSES.has(payload.status)
          ? (payload.status as MemberState["status"])
          : task.status,
      ...(task.error ? { error: task.error } : {}),
    };
    await store.saveSessionEntry({
      id,
      sessionID: owner.sessionId,
      type: SESSION_ENTRY_TEAM_MEMBER,
      touchSession: false,
      time: { created: previous?.time.created ?? now, updated: now },
      data: state,
    });
    return isCurrent();
  });
  writes.set(
    owner,
    work.then(
      () => undefined,
      () => undefined,
    ),
  );
  return work;
}

export async function restorePersistedLocalAgents(
  owner: MemberOwner,
  memoryEvents: readonly SessionEvent[],
): Promise<RuntimeTaskSnapshot[]> {
  const entries =
    (await owner.sessionStore?.sessionEntries?.({
      sessionID: owner.sessionId,
      type: SESSION_ENTRY_TEAM_MEMBER,
    })) ?? [];
  const states = entries
    .map((entry) => {
      const state = parseState(entry.data);
      if (!state) throw new Error(`Invalid persisted team member ${entry.id}`);
      return state;
    })
    .sort((a, b) => a.startedAt - b.startedAt);
  // 这些对象只供既有 registry reducer 读取，不 append 到内存 eventStore，避免重启制造新 sequence。
  const durable = states.flatMap((state): SessionEvent[] => {
    const base = {
      sessionId: owner.sessionId,
      traceId: state.traceId,
      sequenceNumber: 0,
      payload: { ...state, parentSessionId: owner.sessionId },
    };
    const spawn = {
      ...base,
      id: `${state.agentId}:restored-spawn`,
      type: SessionEventType.SubagentSpawned,
      timestamp: new Date(state.startedAt),
    } as SessionEvent;
    return state.status === "running"
      ? [spawn]
      : [
          spawn,
          {
            ...base,
            id: `${state.agentId}:restored-stop`,
            type: SessionEventType.SubagentStopped,
            timestamp: new Date(state.updatedAt),
          } as SessionEvent,
        ];
  });
  return restoreLocalAgentsFromEvents(
    owner.sessionId,
    [...memoryEvents, ...durable],
    owner.runtimeTaskRegistry,
    owner.branchGeneration,
  );
}

function parseState(value: unknown): MemberState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  const nonempty = (key: string) =>
    typeof state[key] === "string" && (state[key] as string).length > 0;
  if (
    !["agentId", "agentType", "childSessionId", "description", "traceId"].every(nonempty) ||
    typeof state.background !== "boolean" ||
    !STATUSES.has(String(state.status)) ||
    !Number.isSafeInteger(state.branchGeneration) ||
    (state.branchGeneration as number) < 0 ||
    !Number.isFinite(state.startedAt) ||
    !Number.isFinite(state.updatedAt) ||
    ["runId", "teamMemberName", "parentToolCallId", "outputFile", "error"].some(
      (key) => state[key] !== undefined && typeof state[key] !== "string",
    )
  )
    return undefined;
  return value as MemberState;
}
