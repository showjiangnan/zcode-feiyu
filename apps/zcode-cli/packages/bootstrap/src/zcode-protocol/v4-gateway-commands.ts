// Modified by ZCode Feiyu.
import type { SessionId } from "@zcode/contracts";

import { createExternalTurnFaultError } from "@zcode/core";

import { lookupGlobalCreateSessionCommand } from "../zcode-protocol-v4/create-session-command-fact.js";

import {
  ConversationV4Gateway,
  V4CommandNotImplementedError,
} from "../zcode-protocol-v4/v4-gateway.js";

import { isConversationInputAdmissionCommand } from "./v4-bridge-input.js";

import type { V4GatewaySurfaceInput } from "./v4-gateway-surface-types.js";
// 方法投影复用单一 gateway context、registry 和 admission；不新增接受队列。
export function createV4GatewayCommands(
  input: V4GatewaySurfaceInput,
): Pick<
  ConstructorParameters<typeof ConversationV4Gateway>[0],
  | "executeCommand"
  | "admitCommandInput"
  | "cancelCommandInput"
  | "terminateTurnForProjectionFault"
  | "lookupRequestFingerprint"
  | "lookupTranscriptCommand"
  | "lookupTimelineCommand"
  | "lookupChildCommand"
  | "lookupDiscardedCommand"
  | "invalidatePersistentCommandFacts"
> {
  const { context, nativeExecutor, coreHost, persistentCommands } = input;
  return {
    // 回落面已清零（20 命令全部原生）：supports 未命中（未知命令类型）→
    // notImplemented → ACK failed fault.command.notImplemented。
    executeCommand: (envelope, admission) =>
      nativeExecutor.supports(envelope.type)
        ? nativeExecutor.execute(envelope, admission)
        : Promise.reject(new V4CommandNotImplementedError(envelope.type)),

    admitCommandInput: async (envelope, admission) => {
      // 仅隐藏 composer 不能阻止旧 child 标签页续聊。类型准入必须早于
      // ledger/输入历史写入；detached child 没有 record 时只查元数据，不激活第二个 runtime。
      if (
        envelope.sessionId &&
        (isConversationInputAdmissionCommand(envelope.type) ||
          envelope.type === "resumeGoal" ||
          envelope.type === "sendQueuedNow" ||
          envelope.type === "forkAssistant" ||
          envelope.type === "createSelectionSideSession")
      ) {
        const taskType =
          context.sessions.get(envelope.sessionId)?.taskType ??
          (await context.deps.sessionStore?.getSession(envelope.sessionId as SessionId))?.taskType;
        if (taskType === "subagent_child") {
          throw Object.assign(new Error("Subagent sessions are read-only"), {
            reasonCode: "guard.subagentReadOnly",
          });
        }
      }
      if (!isConversationInputAdmissionCommand(envelope.type)) return null;
      if (!envelope.sessionId) return null;
      return (await coreHost.admitInputCommand?.(envelope, envelope.sessionId, admission)) ?? null;
    },

    cancelCommandInput: async (envelope, queueItemId, reason) => {
      if (!envelope.sessionId) return;
      await coreHost.cancelInputCommand?.(envelope.sessionId, queueItemId, reason);
    },

    terminateTurnForProjectionFault: (sessionId, reasonCode) => {
      const record = context.sessions.get(sessionId);
      const controller = record?.activeAbortController;
      if (!controller || controller.signal.aborted) return;
      // 投影越过 16MiB 后继续生成只会让所有后续 snapshot 都无法编码。
      // gateway 先原子拒绝越界事件并登记 protocol fault，再单次调用这里中止模型 turn；
      // abort 的正常终态负责释放 active lock，不能在 gateway 里越层伪造 TurnError。
      controller.abort(createExternalTurnFaultError(reasonCode));
    },

    // commands/query 持久化 fallback：同 session 首次查询惰性建索引，后续四个来源
    // 共用该索引；anchor/marker/child/discarded 写入走 record 增量更新。
    lookupRequestFingerprint: async (key) => {
      if (!key.sessionId) return null;
      const input = await context.deps.sessionStore?.getSessionInputById?.(
        `queue_${key.commandId}`,
      );
      if (input?.sessionID !== key.sessionId) return null;
      return typeof input.payload.requestFingerprint === "string"
        ? input.payload.requestFingerprint
        : null;
    },

    lookupTranscriptCommand: async (key) => {
      if (key.sessionId === null)
        return lookupGlobalCreateSessionCommand(context.deps.sessionStore, key.commandId);
      const transcript = await persistentCommands.lookup("transcript", key);
      // 创建命令在 global bucket 接收；新任务内的冷查询仍须按目标身份读同一 origin。
      return (
        transcript ??
        lookupGlobalCreateSessionCommand(context.deps.sessionStore, key.commandId, key.sessionId)
      );
    },

    lookupTimelineCommand: (key) => persistentCommands.lookup("timeline", key),

    lookupChildCommand: (key) => persistentCommands.lookup("child", key),

    lookupDiscardedCommand: (key) => persistentCommands.lookup("discarded", key),

    invalidatePersistentCommandFacts: (sessionId) => persistentCommands.invalidate(sessionId),
  };
}
