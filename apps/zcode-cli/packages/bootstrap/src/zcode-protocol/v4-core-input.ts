// Modified by ZCode Feiyu.
import { commandRequestFingerprint } from "../zcode-protocol-v4/command-fingerprint.js";

import type { SessionId } from "@zcode/contracts";

import { conversationInputIntentSchema } from "@zcode/shared/zcode-protocol-v4";

import { queueItemIdForCommand } from "../zcode-protocol-v4/command-inbox.js";

import type { V4CommandCoreHost } from "../zcode-protocol-v4/commands/types.js";

import { savePersistentCommandFact } from "../zcode-protocol-v4/persistent-command-facts.js";

import { resolveInputCommandForAdmission } from "./v4-bridge-input.js";

import type { V4CoreHostInput } from "./v4-core-host-types.js";
// 方法投影复用单一 gateway context、registry 和 admission；不新增接受队列。
export function createV4CoreInput(
  input: V4CoreHostInput,
): Pick<
  V4CommandCoreHost,
  | "admitInputCommand"
  | "recordInputExecutionFailure"
  | "cancelInputCommand"
  | "discardSharedContext"
  | "recordPersistentCommandFact"
> {
  const { context, persistentCommands } = input;
  return {
    admitInputCommand: async (envelope, sessionId, admission) => {
      if (!context.deps.sessionStore?.saveSessionInput) return null;
      const input = resolveInputCommandForAdmission(
        envelope,
        sessionId,
        (sourceSessionId, target, action) =>
          context.v4Gateway?.resolveRowActionTarget(sourceSessionId, target, action) ?? null,
      );
      if (!input) return null;
      const kind = input.kind;
      const record = context.sessions.get(sessionId);
      if (record) {
        // immediate 新会话也可能尚未写过首条输入；协议镜像不能证明 session 外键已落盘。
        // 统一交给 Core 的幂等持久化边界判断，避免后台首发在 ledger 写入时 FK 失败。
        await record.app.runtime.ensureSessionPersistedForExternalActivity(input.text ?? "", {
          traceContext: record.traceContext,
        });
        record.persistence = "immediate";
      }
      const routingMode = context.v4Gateway?.getInputRoutingMode(sessionId) ?? null;
      // 这是执行前账本的“预计投递边界”；TurnSteerQueued 会用实际 delivery/回退原因
      // 幂等更新同一记录。startNow 不能伪装成 queue，否则重启 discarded 的诊断事实失真。
      const requestedDelivery =
        input.requestedDelivery ??
        (kind === "compact" && routingMode !== null && routingMode !== "startNow"
          ? "queue"
          : routingMode === "enqueue"
            ? "queue"
            : routingMode === "guide" && kind === "sendText"
              ? "guide"
              : "startNow");
      const attachmentRefs = input.attachments;
      const fallbackReasonCode =
        input.fallbackReasonCode ??
        (requestedDelivery === "guide" && attachmentRefs.length > 0
          ? "guide.attachmentsUnsupported"
          : undefined);
      const admittedDelivery =
        input.admittedDelivery ??
        (fallbackReasonCode
          ? "queue"
          : requestedDelivery === "auto"
            ? "startNow"
            : requestedDelivery);
      const conversationInputIntent = conversationInputIntentSchema.parse({
        ...(input.inputOrigin ? { inputOrigin: input.inputOrigin } : {}),
        ...(input.conversationQuotes ? { conversationQuotes: input.conversationQuotes } : {}),
        ...(input.botGroupSource ? { botGroupSource: input.botGroupSource } : {}),
        sourceCommandId: envelope.commandId,
        queueItemId: admission.queueItemId,
        clientId: envelope.clientId || "cli",
        kind,
        text: input.text ?? "",
        ...(input.causalContext ? { causalContext: input.causalContext } : {}),
        ...(input.interTaskSourceTaskId
          ? { interTaskSourceTaskId: input.interTaskSourceTaskId }
          : {}),
        attachments: attachmentRefs,
        ...(input.sharedContextRefs ? { sharedContextRefs: input.sharedContextRefs } : {}),
        delivery: {
          requested: requestedDelivery,
          admitted: admittedDelivery,
          ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
        },
        order: { admissionSeq: admission.admissionSeq },
        steer: fallbackReasonCode
          ? { state: "fellBack", reasonCode: fallbackReasonCode }
          : requestedDelivery === "guide"
            ? { state: "submitting" }
            : { state: "notRequested" },
        dispatch: { state: "admitted" },
        admittedAt: admission.admittedAt,
        ...(input.highspeed ? { highspeed: input.highspeed } : {}),
        ...(input.provenance ? { provenance: input.provenance } : {}),
      });
      await context.deps.sessionStore.saveSessionInput({
        id: admission.queueItemId,
        sessionID: sessionId as SessionId,
        kind,
        delivery: conversationInputIntent.delivery.admitted,
        payload: {
          requestFingerprint: commandRequestFingerprint(envelope),
          text: conversationInputIntent.text,
          intent: {
            sourceCommandId: conversationInputIntent.sourceCommandId,
            ...(conversationInputIntent.causalContext
              ? { causalContext: conversationInputIntent.causalContext }
              : {}),
            ...(conversationInputIntent.interTaskSourceTaskId
              ? { interTaskSourceTaskId: conversationInputIntent.interTaskSourceTaskId }
              : {}),
            queueItemId: conversationInputIntent.queueItemId,
            clientId: conversationInputIntent.clientId,
            kind: conversationInputIntent.kind,
            admissionSeq: admission.admissionSeq,
            admittedAt: admission.admittedAt,
            requestedDelivery: conversationInputIntent.delivery.requested,
            admittedDelivery: conversationInputIntent.delivery.admitted,
            ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
            attachmentRefs,
            ...(conversationInputIntent.sharedContextRefs
              ? { sharedContextRefs: conversationInputIntent.sharedContextRefs }
              : {}),
          },
          conversationInputIntent,
          attachments: attachmentRefs,
          ...(conversationInputIntent.sharedContextRefs
            ? { sharedContextRefs: conversationInputIntent.sharedContextRefs }
            : {}),
          sourceCommandType: envelope.type,
        },
      });
      if (
        conversationInputIntent.sharedContextRefs?.length &&
        conversationInputIntent.delivery.admitted !== "startNow"
      ) {
        const reference = conversationInputIntent.sharedContextRefs[0]!;
        const reserved = await context.deps.sessionStore.transitionSharedContextImport?.({
          sessionID: sessionId as SessionId,
          contextId: reference.context_id,
          expectedStatus: "pending",
          status: "reserved",
          sourceId: admission.queueItemId,
        });
        if (!reserved) {
          await context.deps.sessionStore.settleSessionInput?.({
            id: admission.queueItemId,
            sessionID: sessionId as SessionId,
            status: "failed",
            reason: "shared_context_not_attachable",
          });
          throw new Error("fault.command.sharedContextNotAttachable");
        }
        const entry = (
          await context.deps.sessionStore.sessionEntries?.({
            sessionID: sessionId as SessionId,
            type: "v4/shared_context_import",
          })
        )?.find((candidate) => {
          const data = candidate.data;
          return Boolean(
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            (data as Record<string, unknown>).contextId === reference.context_id,
          );
        });
        const data = entry?.data;
        const session = await context.deps.sessionStore.getSession(sessionId as SessionId);
        if (
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          typeof (data as Record<string, unknown>).shareUrl === "string" &&
          session?.title
        ) {
          context.v4Gateway?.updateSharedContextImport(sessionId, {
            contextId: reference.context_id,
            title: session.title,
            shareUrl: String((data as Record<string, unknown>).shareUrl),
            status: "reserved",
          });
        }
      }
      return conversationInputIntent;
    },

    recordInputExecutionFailure: async (sessionId, commandId) => {
      // Store 的 admitted 条件更新保护已 promoted 的输入，不能把已落转录的轮倒退为失败接收。
      await context.deps.sessionStore?.settleSessionInput?.({
        id: queueItemIdForCommand(commandId),
        sessionID: sessionId as SessionId,
        status: "failed",
        reason: "fault.command.inputExecutionFailed",
      });
      persistentCommands.invalidate(sessionId);
      const ack = await persistentCommands.lookup("discarded", { sessionId, commandId });
      if (ack?.reasonCode === "fault.command.inputExecutionFailed")
        await context.v4Gateway?.reconcileFailedInput(sessionId, ack);
    },

    cancelInputCommand: async (sessionId, queueItemId, reason) => {
      await context.deps.sessionStore?.settleSessionInput?.({
        id: queueItemId,
        sessionID: sessionId as SessionId,
        status: "cancelled",
        reason,
      });
      const store = context.deps.sessionStore;
      const entries = await store?.sessionEntries?.({
        sessionID: sessionId as SessionId,
        type: "v4/shared_context_import",
      });
      const reserved = entries?.find((entry) => {
        const data = entry.data;
        return Boolean(
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          (data as Record<string, unknown>).status === "reserved" &&
          (data as Record<string, unknown>).sourceId === queueItemId,
        );
      });
      const contextId =
        reserved?.data && typeof reserved.data === "object"
          ? (reserved.data as Record<string, unknown>).contextId
          : undefined;
      if (typeof contextId === "string") {
        await store?.transitionSharedContextImport?.({
          sessionID: sessionId as SessionId,
          contextId,
          expectedStatus: "reserved",
          status: "pending",
          sourceId: queueItemId,
        });
      }
    },

    discardSharedContext: async (sessionId, contextId) => {
      const store = context.deps.sessionStore;
      if (!store?.transitionSharedContextImport) return false;
      const updated = await store.transitionSharedContextImport({
        sessionID: sessionId as SessionId,
        contextId,
        expectedStatus: "pending",
        status: "discarded",
      });
      if (updated) {
        const entry = (
          await store.sessionEntries?.({
            sessionID: sessionId as SessionId,
            type: "v4/shared_context_import",
          })
        )?.find((candidate) => {
          const data = candidate.data;
          return Boolean(
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            (data as Record<string, unknown>).contextId === contextId,
          );
        });
        const data = entry?.data;
        const session = await store.getSession(sessionId as SessionId);
        if (
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          typeof (data as Record<string, unknown>).shareUrl === "string" &&
          typeof (data as Record<string, unknown>).contextId === "string" &&
          session?.title
        ) {
          context.v4Gateway?.updateSharedContextImport(sessionId, {
            contextId: String((data as Record<string, unknown>).contextId),
            title: session.title,
            shareUrl: String((data as Record<string, unknown>).shareUrl),
            status: "discarded",
          });
        }
      }
      return updated;
    },

    recordPersistentCommandFact: async (sessionId, source, ack, metadata) => {
      const store = context.deps.sessionStore;
      const live = context.sessions.get(sessionId);
      const stored = await store?.getSession(sessionId as SessionId);
      if (!store || (!live && !stored)) {
        throw new Error("fault.command.persistentFactSessionNotFound");
      }
      await savePersistentCommandFact(store, sessionId as SessionId, source, ack, metadata);
      const workspacePath = live?.workspace.workspacePath ?? stored?.directory;
      if (!workspacePath) throw new Error("fault.command.persistentFactWorkspaceMissing");
      const workspaceIdentity = live?.workspace.workspaceIdentity ?? stored?.workspaceID;
      await persistentCommands.record(
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity: String(workspaceIdentity) } : {}),
        },
        sessionId,
        source,
        ack,
      );
    },
  };
}
