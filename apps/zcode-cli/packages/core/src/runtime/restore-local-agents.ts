// Modified by ZCode Feiyu contributors (2026).
import { SessionEventType, type SessionEvent, type SessionId } from "@zcode/contracts";
import type { RuntimeTaskRegistry, RuntimeTaskSnapshot } from "../runtime-task/registry.js";

const MAX_RESTORED_AGENTS = 128;
const TERMINAL = new Set<RuntimeTaskSnapshot["status"]>([
  "completed",
  "failed",
  "cancelled",
  "killed",
  "stopped",
  "lost",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function terminalStatus(value: unknown): RuntimeTaskSnapshot["status"] {
  return typeof value === "string" && TERMINAL.has(value as RuntimeTaskSnapshot["status"])
    ? (value as RuntimeTaskSnapshot["status"])
    : "lost";
}

export function restoreLocalAgentsFromEvents(
  sessionId: SessionId,
  events: readonly SessionEvent[],
  registry: RuntimeTaskRegistry,
  branchGeneration = 0,
): RuntimeTaskSnapshot[] {
  const tasks = new Map<string, RuntimeTaskSnapshot>();
  for (const event of events) {
    if (
      event.sessionId !== sessionId ||
      (event.type !== SessionEventType.SubagentSpawned &&
        event.type !== SessionEventType.SubagentStopped)
    )
      continue;
    const payload = record(event.payload);
    if (!payload) continue;
    const eventGeneration =
      typeof payload.branchGeneration === "number" ? payload.branchGeneration : 0;
    if (eventGeneration !== branchGeneration) continue;
    const agentId = nonempty(payload.agentId);
    if (!agentId) continue;
    const previous = tasks.get(agentId);
    if (event.type === SessionEventType.SubagentSpawned) {
      const childSessionId = nonempty(payload.childSessionId) ?? previous?.childSessionId;
      if (!childSessionId) continue;
      const runId = nonempty(payload.runId);
      // Map.set 不更新插入顺序；最近续跑的老成员也必须占据有界目录的最近位置。
      tasks.delete(agentId);
      tasks.set(agentId, {
        taskId: agentId,
        agentId,
        agentType: nonempty(payload.agentType) ?? previous?.agentType ?? "general-purpose",
        childSessionId: childSessionId as SessionId,
        description: nonempty(payload.description) ?? previous?.description ?? "Local agent",
        isBackgrounded: payload.background === true || previous?.isBackgrounded === true,
        branchGeneration,
        outputFile: nonempty(payload.outputFile) ?? previous?.outputFile,
        parentToolCallId: nonempty(payload.parentToolCallId) ?? previous?.parentToolCallId,
        parentSessionId: sessionId,
        prompt: nonempty(payload.prompt) ?? previous?.prompt,
        teamMemberName: nonempty(payload.teamMemberName) ?? previous?.teamMemberName,
        startedAt: event.timestamp,
        ...(runId ? { traceContext: { traceId: event.traceId, spanId: runId, sessionId } } : {}),
        status: "running",
        taskType: "local_agent",
        type: "local_agent",
      });
      continue;
    }
    if (previous) {
      const runId = nonempty(payload.runId);
      const currentRunId = previous.traceContext?.spanId;
      // 同成员新轮启动后，旧轮终态不能覆盖它；旧格式缺 run 只可保守标记 lost。
      if (runId !== currentRunId && (runId !== undefined || payload.status !== "lost")) continue;
      tasks.set(agentId, {
        ...previous,
        status: terminalStatus(payload.status),
        completedAt: event.timestamp,
        error: nonempty(payload.error) ?? previous.error,
        outputFile: nonempty(payload.outputFile) ?? previous.outputFile,
      });
    }
  }
  const recent = [...tasks.values()].slice(-MAX_RESTORED_AGENTS);
  const lost: RuntimeTaskSnapshot[] = [];
  for (const task of recent) {
    if (registry.get(task.taskId)) continue;
    if (task.status === "running") {
      const interrupted = {
        ...task,
        status: "lost" as const,
        completedAt: new Date(),
        error: "The local agent process ended before its result was committed",
      };
      registry.register(interrupted);
      lost.push(interrupted);
    } else {
      registry.register(task);
    }
  }
  return lost;
}
