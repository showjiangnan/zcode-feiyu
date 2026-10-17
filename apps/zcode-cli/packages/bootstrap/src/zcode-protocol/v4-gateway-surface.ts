// Modified by ZCode Feiyu.
import type { V4GatewaySurfaceInput } from "./v4-gateway-surface-types.js";
import { createV4GatewayPersistence } from "./v4-gateway-persistence.js";
import { createV4GatewayArtifacts } from "./v4-gateway-artifacts.js";
import { createV4GatewayCommands } from "./v4-gateway-commands.js";

import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { V4_NOTIFICATIONS } from "@zcode/shared/zcode-protocol-v4";

import { isTaskListSessionType } from "../zcode-protocol-v4/task-list-session-membership.js";
import { ConversationV4Gateway } from "../zcode-protocol-v4/v4-gateway.js";
import { cloneModelSelection } from "./fork-model-selection.js";

import { readSessionContextUsage } from "./server-operations.js";

import { buildLiveWorkspaceConfigStateV4 } from "./v4-workspace-config.js";
import { resolveSessionModelContextWindow } from "./workspace-model-runtime.js";

import { sessionUsageSeedFromRuntimeContextUsage } from "./v4-bridge-records.js";
import { persistHighspeedTimingOnTurnTerminal } from "./v4-bridge-fork.js";
// 装配阶段复用同一实例与闭包，不另建运行状态或副作用路径。
export function createV4GatewaySurface(input: V4GatewaySurfaceInput): ConversationV4Gateway {
  const { context, log, autoDrainV4QueueIfReady, loadStoredSessionSummaries } = input;

  return new ConversationV4Gateway({
    cliVersion: context.deps.version,

    sessionExists: (sessionId) => context.sessions.has(sessionId),

    onDebug: (message) => log?.debug(message),

    onTargetCompleted: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return;
      // background task-notification 的 goal verifier 不经过 v4 prompt 的
      // finally/afterLegacyStateMutation；TargetChanged(complete) 虽已提交，future queue
      // 因而没有下一次 mutation 来重评。这里只 detached 触发既有 gate，不能阻塞投影。
      void Promise.resolve()
        .then(() => autoDrainV4QueueIfReady(record))
        .catch((error: unknown) => {
          context.logger?.warn("v4 auto-drain reevaluation after target completion failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
        });
    },

    onHighspeedTurnTerminal: (sessionId, event, snapshot) => {
      persistHighspeedTimingOnTurnTerminal(context, sessionId, event, snapshot);
    },
    ...createV4GatewayPersistence(input),

    emitWireFrame: (wire) =>
      context.notify({
        method: V4_NOTIFICATIONS.conversationFrame,
        params: wire,
      }),

    emitLocalTtftFacts: (facts) =>
      context.notify({ method: V4_NOTIFICATIONS.localTtftFacts, params: facts }),

    emitConversationTelemetryFact: (fact) =>
      context.notify({
        method: V4_NOTIFICATIONS.conversationTelemetryFact,
        params: fact,
      }),

    emitCuaPermissionObservation: (observation) =>
      context.notify({
        method: V4_NOTIFICATIONS.cuaPermissionObservation,
        params: observation,
      }),

    // ── config 种子：投影初值 = runtime 真值 ─────────────
    // 覆盖三个种子来源：启动缺省（Workspace 模型偏好 + 项目持久化 mode）、
    // createSession.config（handler 先应用到 runtime 再种）、历史会话 resume
    // （App 恢复结果可以只有模型身份，不能为了投影而绑定半成品执行模型）。
    getSessionMemoryEnabled: (sessionId) => context.sessions.get(sessionId)?.memoryEnabled,

    getSessionConfigSeed: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      const selection =
        record.app.runtime.getSessionModelSelection() ?? record.restoredModelSelection;
      return {
        modelSelection: cloneModelSelection(selection),
        provider: selection?.providerId ?? "",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
        thoughtLevels: selection
          ? (record.app
              .listModels()
              .find(
                (model) =>
                  model.ref.providerId === selection.providerId &&
                  model.ref.modelId === selection.modelId,
              )
              ?.reasoning?.levels.map((level) => level.value) ?? [])
          : [],
        mode: record.app.getMode(),
        suggestedPrompt: record.app.runtime.getSuggestedPromptState(),
        orchestration: record.app.runtime.getOrchestrationState(),
        planEnabled: record.app.runtime.getPlanEnabled(),
        ...(record.app.runtime.lastPermissionGrantId
          ? { permissionGrant: { interactionId: record.app.runtime.lastPermissionGrantId } }
          : {}),
      };
    },

    getSessionUsageSeed: async (sessionId, persistedMessages) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      const contextUsage = await readSessionContextUsage(context, sessionId, persistedMessages);
      // usage seed 会在 hydration 后再次覆盖首帧分母；必须与合成事件
      // 使用同一份当前模型 registry 真值，不能把旧 runtime projection 的窗口写回来。
      return sessionUsageSeedFromRuntimeContextUsage(
        contextUsage,
        resolveSessionModelContextWindow(context, record),
      );
    },

    // ── sessions-index hooks（workspace 分桶 + 冷启动 store 种子）──────────
    getSessionWorkspaceId: (sessionId) => {
      const record = context.sessions.get(sessionId);
      return !record || !isTaskListSessionType(record.taskType)
        ? null
        : record.workspace.workspaceKey;
    },

    getSessionIndexMeta: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      return {
        createdAt: record.createdAt,
        lastActivityAt: record.updatedAt,
        ...(record.parentSessionId ? { parentSessionId: String(record.parentSessionId) } : {}),
      };
    },

    listWorkspaceSessionIds: (workspaceId) =>
      [...context.sessions.values()]
        .filter(
          (record) =>
            isTaskListSessionType(record.taskType) && record.workspace.workspaceKey === workspaceId,
        )
        .map((record) => record.app.sessionId),

    // draft 判定：deferred = 未发首条输入（prompt-turn 首发提升为 immediate）。
    // 旧 workspace prepare 预建的 deferred 会话不得以「新任务」漏进侧栏列表。
    isDraftSession: (sessionId) => context.sessions.get(sessionId)?.persistence === "deferred",

    // ── workspace-config hook（配置目录订阅种子；live session 快路径，避免临时 app）──
    getWorkspaceConfig: (workspaceId) => buildLiveWorkspaceConfigStateV4(context, workspaceId),

    getStoredSessionSummaries: loadStoredSessionSummaries,

    refreshLegacySessionSummaries: (workspaceId, legacyTaskIds) =>
      parseRemoteWorkspaceIdentity(workspaceId)
        ? loadStoredSessionSummaries(workspaceId, legacyTaskIds)
        : null,
    ...createV4GatewayCommands(input),
    ...createV4GatewayArtifacts(input),

    onError: (scope, error, errorContext) =>
      context.logger?.warn("ZCode Protocol v4 gateway error", {
        ...errorContext,
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.v4.gateway_error",
        module: "bootstrap.zcode_protocol",
        scope,
      }),
  });
}
