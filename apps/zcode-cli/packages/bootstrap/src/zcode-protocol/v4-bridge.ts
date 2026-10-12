// Modified by ZCode Feiyu.
import { createV4CoreHost } from "./v4-core-host.js";
import { createV4GatewaySurface } from "./v4-gateway-surface.js";

import type { GoalStatus, SessionId, WorkspaceId } from "@zcode/contracts";

import { parseRemoteWorkspaceIdentity } from "@zcode/shared";

import { V4CommandExecutor } from "../zcode-protocol-v4/commands/executor.js";

import { V4QueuePromotionLeaseUnavailableError } from "../zcode-protocol-v4/commands/handlers/queue.js";
import type { V4QueuedTurnExecution } from "../zcode-protocol-v4/commands/types.js";

import { loadPersistentCommandFacts } from "../zcode-protocol-v4/persistent-command-facts.js";
import { PersistentCommandIndex } from "../zcode-protocol-v4/persistent-command-index.js";

import { shouldAutoDrainV4QueueHead } from "../zcode-protocol-v4/queue-auto-drain.js";

import { TASK_LIST_SESSION_TYPES } from "../zcode-protocol-v4/task-list-session-membership.js";
import { ConversationV4Gateway } from "../zcode-protocol-v4/v4-gateway.js";

import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { createProtocolLogger } from "./server-types.js";

import { normalizeStoredTitleSource } from "./v4-bridge-records.js";
export {
  resolveInputCommandForAdmission,
  isConversationInputAdmissionCommand,
} from "./v4-bridge-input.js";
export {
  registerCommittedForkBestEffort,
  type HighspeedTurnTerminalPersistenceContext,
  persistHighspeedTimingOnTurnTerminal,
} from "./v4-bridge-fork.js";
// 按职责拆分；保留原始规则、执行顺序与状态所有者。

export function createConversationV4Gateway(
  context: ZCodeProtocolAgentServerContext,
): ConversationV4Gateway {
  const log = createProtocolLogger(context.deps)?.child({
    module: "bootstrap.zcode_protocol_v4_gateway",
  });
  const persistentCommands = new PersistentCommandIndex({
    loadSession: async (sessionId) => {
      const live = context.sessions.get(sessionId);
      const stored = await context.deps.sessionStore?.getSession(sessionId as SessionId);
      if (!live && !stored) return null;
      const workspacePath = live?.workspace.workspacePath ?? stored?.directory;
      if (!workspacePath) return null;
      const workspaceIdentity = live?.workspace.workspaceIdentity ?? stored?.workspaceID;
      const facts = context.deps.sessionStore
        ? await loadPersistentCommandFacts(context.deps.sessionStore, sessionId as SessionId, {
            discardAdmittedOnLoad: !live,
          })
        : undefined;
      return {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity: String(workspaceIdentity) } : {}),
        ...(facts ? { facts } : {}),
      };
    },
  });
  let nativeExecutor: V4CommandExecutor;
  const autoDrainRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Highspeed 执行材料含临时凭据：只按 session/sourceCommandId 驻留内存，绝不进入
  // TurnSteerQueued、snapshot 或 transcript。CLI 重启后缺失时队列提升自动走原模型。
  const queuedTurnExecutions = new Map<string, Map<string, V4QueuedTurnExecution>>();
  const autoDrainV4QueueIfReady = async (record: ZCodeProtocolSessionRecord): Promise<void> => {
    const head = context.v4Gateway?.getQueueHead(record.app.sessionId);
    if (!head) {
      // 外层恢复 FIFO 已消费到空；guide 仍只由 core tool-batch 边界行内消费。
      record.app.completeExternalQueueDrain();
      return;
    }
    const coreForegroundBusy = record.app.runtime.getActiveForegroundExecutionId() !== undefined;
    if (
      head.autoDrain &&
      head.dispatchState === "queued" &&
      (record.activeAbortController !== undefined || coreForegroundBusy)
    ) {
      // Bootstrap controller 不覆盖 model-only notification；旧 auto-drain
      // 只看外层锁，因而把“空闲后消费”错误执行成抢占。busy 时不碰 reservation。
      scheduleAutoDrainRetry(record);
      return;
    }
    let targetStatus: GoalStatus | null = null;
    if (head.autoDrain && head.dispatchState === "queued" && !record.activeAbortController) {
      try {
        targetStatus = (await record.app.readTarget())?.status ?? null;
      } catch (error) {
        // target 读取失败时按“未知且未完成”处理；直接提升会让
        // goal verification 的持久终态尚未可证时普通 queue 偷跑。
        context.logger?.warn("v4 auto-drain held because target state could not be read", {
          error: error instanceof Error ? error.message : String(error),
          queueItemId: head.queueItemId,
          sessionId: record.app.sessionId,
        });
        return;
      }
    }
    if (
      !shouldAutoDrainV4QueueHead({
        autoDrain: head.autoDrain,
        dispatchState: head.dispatchState,
        sessionBusy: Boolean(record.activeAbortController) || coreForegroundBusy,
        targetStatus,
      })
    ) {
      return;
    }
    // 暂停队列恢复后，旧项只存在于投影而不在新 activeTurn 内存中；普通文本也必须
    // 和 typed /goal、/compact 一样走完整投影的队首，避免新输入越过旧暂停项。
    try {
      await nativeExecutor.execute(
        {
          baseRevision: 0,
          clientId: "v4-auto-drain",
          commandId: `auto-${head.kind}-${Date.now()}-${head.queueItemId}`,
          issuedAt: Date.now(),
          payload: { queueItemId: head.queueItemId },
          sessionId: record.app.sessionId,
          type: "sendQueuedNow",
        },
        undefined,
        { autoDrainPromotion: true },
      );
    } catch (error) {
      if (error instanceof V4QueuePromotionLeaseUnavailableError) {
        // precheck 与 handler 之间可能新入队 notification；idle-only 是最终原子判据。
        scheduleAutoDrainRetry(record);
        return;
      }
      // 自动提升失败不能继续越过该 FIFO barrier；重新暂停并保留原项，交用户重试。
      await record.app.setQueueAutoDrain(false);
      context.logger?.warn("v4 auto-drain failed and queue was paused", {
        error: error instanceof Error ? error.message : String(error),
        queueItemId: head.queueItemId,
        sessionId: record.app.sessionId,
      });
    }
  };
  const scheduleAutoDrainRetry = (record: ZCodeProtocolSessionRecord): void => {
    const sessionId = record.app.sessionId;
    if (autoDrainRetryTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      autoDrainRetryTimers.delete(sessionId);
      if (context.sessions.get(sessionId) !== record) return;
      void autoDrainV4QueueIfReady(record).catch((error: unknown) => {
        context.logger?.warn("v4 auto-drain idle reevaluation failed", {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });
      });
    }, 100);
    timer.unref?.();
    autoDrainRetryTimers.set(sessionId, timer);
  };
  const { coreHost } = createV4CoreHost({
    context,
    queuedTurnExecutions,
    persistentCommands,
    autoDrainV4QueueIfReady,
  });
  nativeExecutor = new V4CommandExecutor(coreHost);
  const loadStoredSessionSummaries = async (
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ) => {
    // 未加载会话的轻量摘要：store 元信息 → SessionSummary（phase 取空闲完成态默认、
    // sessionEnded=true 对齐 「成功轮收口即 true」口径；加载后的准确
    // phase/preview/backgroundWork 由 gateway 用 live 投影覆盖）。
    // workspaceKey 的本地 fallback = workspacePath，故用它作 listSessions 的 directory 过滤。
    if (!context.deps.sessionStore) return [];
    try {
      // 远端 sessions-index 的 workspaceId 是隔离 identity，而 session store 的
      // directory 是实际文件路径。查询必须同时带路径和 identity；否则同一路径下其他
      // authority 的会话会被误标成当前 workspace。legacy 空 identity 不能只凭路径
      // claim，只允许使用 host task-index 给出的精确 taskId 归属证明。
      const parsedRemote = parseRemoteWorkspaceIdentity(workspaceId);
      const persistedWorkspacePath = parsedRemote?.workspacePath ?? workspaceId;
      if (
        parsedRemote &&
        legacyTaskIds &&
        legacyTaskIds.length > 0 &&
        context.deps.sessionStore.claimLegacySessionWorkspace
      ) {
        try {
          const claimedCount = await context.deps.sessionStore.claimLegacySessionWorkspace({
            sessionIDs: legacyTaskIds as SessionId[],
            directory: persistedWorkspacePath,
            workspaceID: workspaceId as WorkspaceId,
          });
          if (claimedCount > 0) {
            context.logger?.info("legacy remote sessions claimed by task-index allowlist", {
              claimedCount,
              event: "zcode_protocol.v4.sessions_index_legacy_remote_claimed",
              module: "bootstrap.zcode_protocol",
              workspaceId,
            });
          }
        } catch (error) {
          // claim 只是旧数据兼容步骤；失败后仍要读取已有完整 identity 的会话。
          // 后续携带 allowlist 的订阅会再次进入这里，不能用失败结果封死迁移。
          context.logger?.warn("legacy remote sessions claim failed; continuing strict load", {
            error: error instanceof Error ? error.message : String(error),
            event: "zcode_protocol.v4.sessions_index_legacy_remote_claim_failed",
            module: "bootstrap.zcode_protocol",
            workspaceId,
          });
        }
      }
      const stored = await context.deps.sessionStore.listSessions({
        directory: persistedWorkspacePath,
        includeArchived: false,
        limit: 200,
        // parentID 只表达会话层级，不能作为左侧任务 membership。
        // 显式 fork 必然带 parentID，但重启后仍应由 taskType 投影进 sessions-index。
        taskTypes: [...TASK_LIST_SESSION_TYPES],
        workspaceID: parsedRemote ? (workspaceId as WorkspaceId) : null,
      });
      return stored.map((session) => ({
        sessionId: String(session.id),
        workspaceId,
        ...(session.parentID ? { parentSessionId: String(session.parentID) } : {}),
        title: session.title ?? "",
        titleSource: normalizeStoredTitleSource(session.titleSource),
        phase: "completedSuccess" as const,
        sessionEnded: true,
        hasBackgroundWork: false,
        lastActivityAt: session.time?.updated ?? 0,
        createdAt: session.time?.created ?? 0,
      }));
    } catch (error) {
      context.logger?.warn("sessions-index stored summaries failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.v4.sessions_index_stored_failed",
        module: "bootstrap.zcode_protocol",
      });
      return [];
    }
  };
  return createV4GatewaySurface({
    context,
    log,
    autoDrainV4QueueIfReady,
    loadStoredSessionSummaries,
    nativeExecutor,
    coreHost,
    persistentCommands,
  });
}
