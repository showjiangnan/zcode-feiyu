// Modified by ZCode Feiyu contributors (2026).
import { orchestrationStateSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  isTaskRoot,
  SESSION_ENTRY_ORCHESTRATION_STATE,
  type SessionId,
  type SessionStorePort,
} from "@zcode/contracts";
import type { WorkspaceMemoryResult, ZCodeWorkspaceRef } from "@zcode/shared";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";
/** 未加载会话的主动状态来自持久编排事实；只有确认无事实时才回落为“未启动”。 */
async function readPersistedProactiveState(
  store: SessionStorePort,
  sessionId: string,
): Promise<{ status: "stopped" | "running" | "paused"; reason: string | null } | undefined> {
  const entries = await store.sessionEntries?.({
    sessionID: sessionId as SessionId,
    type: SESSION_ENTRY_ORCHESTRATION_STATE,
  });
  const parsed = orchestrationStateSchema.safeParse(entries?.at(-1)?.data);
  return parsed.success ? parsed.data.proactive : undefined;
}

export function unsupportedMemoryCapabilities(): WorkspaceMemoryResult {
  return {
    type: "capabilities",
    capabilities: {
      localTasks: {
        supported: false,
        enabled: false,
        available: false,
        reason: "remote_workspace",
        policyRevision: 0,
      },
      orchestration: {
        supported: false,
        enabled: false,
        available: false,
        reason: "remote_workspace",
        policyRevision: 0,
      },
      memoryRead: {
        supported: false,
        enabled: false,
        available: false,
        reason: "remote_workspace",
        policyRevision: 0,
      },
      memoryExtraction: {
        supported: false,
        enabled: false,
        available: false,
        reason: "remote_workspace",
        policyRevision: 0,
      },
      memoryReview: {
        supported: false,
        enabled: false,
        available: false,
        reason: "remote_workspace",
        policyRevision: 0,
      },
      memoryHistory: {
        supported: false,
        enabled: false,
        available: false,
        reason: "remote_workspace",
        policyRevision: 0,
      },
      proactiveWork: {
        supported: false,
        enabled: false,
        available: false,
        reason: "remote_workspace",
        policyRevision: 0,
      },
    },
  };
}
export async function readMemoryCapabilities(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
  sessionId: string,
): Promise<WorkspaceMemoryResult> {
  const store = context.deps.sessionStore;
  if (!store) throw new Error("Memory storage is unavailable");
  const workspaceKey = workspace.workspaceIdentity?.trim() || workspace.workspacePath;
  if (workspace.workspaceKey !== workspaceKey)
    throw new Error("Capability workspace key does not match its identity");
  const session = await store.getSession(sessionId as SessionId);
  if (
    !session ||
    !isTaskRoot(session.taskType, session.parentID) ||
    (session.workspaceID?.trim() || session.directory) !== workspaceKey
  )
    throw new Error("Capability source is outside this workspace");
  const prefs = context.appRuntimePreferences.memory;
  const capability = (supported: boolean, enabled: boolean, reason?: string) => ({
    supported,
    enabled,
    available: supported && enabled && !reason,
    reason: !supported ? "runtime_unsupported" : !enabled ? "disabled_by_policy" : (reason ?? null),
    policyRevision: prefs?.policyRevision ?? 0,
  });
  // 原因：原实现只读当前运行中的 runtime，未加载的会话（未选中/未启动）会被误报为
  // session_start_required。这里回落到该会话的持久编排事实，已启动或已暂停都由事实说话。
  const live = context.sessions.get(sessionId)?.app.runtime.getOrchestrationState().proactive;
  const proactive = live ?? (await readPersistedProactiveState(store, sessionId));
  const proactiveSupported = Boolean(
    context.v4Gateway &&
    store.publishProactiveEvent &&
    store.claimProactiveTriggers &&
    store.settleProactiveTrigger &&
    store.readProactiveTrigger &&
    store.rejectSupersededProactiveTriggers &&
    store.sessionEntries &&
    store.saveSessionEntry,
  );
  const proactiveReason =
    proactive?.status === "running"
      ? undefined
      : proactive?.status === "paused"
        ? (proactive.reason ?? "session_paused")
        : "session_start_required";
  return {
    type: "capabilities",
    capabilities: {
      localTasks: capability(Boolean(context.v4Gateway), true),
      orchestration: capability(Boolean(context.v4Gateway), true),
      memoryRead: capability(true, true),
      memoryExtraction: capability(
        Boolean(store.advanceProjectMemoryExtractionCursor),
        Boolean(prefs?.enabled && prefs.extractionEnabled),
      ),
      memoryReview: capability(
        Boolean(store.claimProjectMemoryReview),
        Boolean(prefs?.enabled && prefs.reviewEnabled),
      ),
      memoryHistory: capability(Boolean(store.withProjectMemoryWriteFence), true),
      proactiveWork: capability(
        proactiveSupported,
        Boolean(prefs?.continuityPolicy?.proactiveWorkAllowed),
        proactiveReason,
      ),
    },
  };
}
