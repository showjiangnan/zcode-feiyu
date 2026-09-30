// Modified by ZCode Feiyu contributors (2026).
import { createHash } from "node:crypto";
import type {
  SubagentSendMessageOptions,
  SubagentSendMessageRequest,
  SubagentSendMessageResult,
} from "@zcode/contracts";
import {
  isTerminalRuntimeTask,
  type RuntimeTaskPendingMessage,
  type RuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
} from "../runtime-task/registry.js";
import type { TeamMessageLedger } from "../runtime/team-message-ledger.js";

const MAX_PENDING_MEMBER_MESSAGES = 32;
const MESSAGE_ID_HASH_LENGTH = 32;

export function isExplicitlyStoppedTask(task: Pick<RuntimeTaskSnapshot, "status">): boolean {
  return task.status === "killed" || task.status === "cancelled" || task.status === "stopped";
}

/** 只路由既有 registry/ledger；不维护第二份成员状态或消息队列。 */
export async function sendMessageToLocalAgent(
  options: {
    teamMessageLedger?: TeamMessageLedger;
    getBranchGeneration?: () => number;
  },
  registry: RuntimeTaskRegistry,
  request: SubagentSendMessageRequest,
  resume: (
    task: RuntimeTaskSnapshot,
    message: RuntimeTaskPendingMessage,
  ) => Promise<SubagentSendMessageResult>,
  sendOptions?: SubagentSendMessageOptions,
): Promise<SubagentSendMessageResult> {
  if (sendOptions?.signal?.aborted) {
    return createSendMessageFailure(request, `SendMessage was aborted for ${request.to}.`);
  }
  const branchGeneration = options.getBranchGeneration?.() ?? 0;
  const original =
    registry.get(request.to) ??
    Object.values(registry.all()).find(
      (candidate) =>
        candidate.type === "local_agent" &&
        candidate.parentSessionId === request.sessionId &&
        candidate.branchGeneration === branchGeneration &&
        candidate.teamMemberName?.normalize("NFKC").toLowerCase() ===
          request.to.normalize("NFKC").toLowerCase(),
    );
  const isTarget = (task: RuntimeTaskSnapshot | undefined): task is RuntimeTaskSnapshot =>
    Boolean(
      task &&
      task.type === "local_agent" &&
      task.parentSessionId === request.sessionId &&
      task.branchGeneration === branchGeneration &&
      branchGeneration === (options.getBranchGeneration?.() ?? 0) &&
      task.childSessionId === original?.childSessionId,
    );
  if (!isTarget(original)) {
    return createSendMessageFailure(
      request,
      `No active local_agent task found for target ${request.to}.`,
    );
  }
  const message = createRuntimeTaskPendingMessage(request, Boolean(original.teamMemberName));
  if (
    !isTerminalRuntimeTask(original) &&
    (original.pendingMessages?.length ?? 0) >= MAX_PENDING_MEMBER_MESSAGES &&
    !original.pendingMessages?.some((pending) => pending.id === message.id)
  ) {
    return createSendMessageFailure(
      request,
      `Local agent ${original.agentId} has ${MAX_PENDING_MEMBER_MESSAGES} pending messages`,
      message.id,
    );
  }
  const ledger = original.teamMemberName ? options.teamMessageLedger : undefined;
  if (original.teamMemberName) {
    if (!ledger || !original.childSessionId) {
      return createSendMessageFailure(
        request,
        "Durable team message delivery is unavailable",
        message.id,
      );
    }
    // 显式 messageId 仅供已接受消息重投；停止后的新显式工具调用才有权恢复成员。
    if (request.messageId && isExplicitlyStoppedTask(original)) {
      await ledger.settle(message.id, "cancelled");
      return createSendMessageFailure(request, "The member was explicitly stopped", message.id);
    }
    const admission = await ledger.admit({
      messageId: message.id,
      agentId: original.agentId,
      childSessionId: original.childSessionId,
      parentToolCallId: String(request.parentToolCallId),
      senderAgentId: request.senderAgentId,
      senderName: request.senderName,
      summary: request.summary,
      message: request.message,
      branchGeneration,
    });
    if (admission === "promoted") return createSendMessageSuccess(original, message, "steered");
    if (admission === "pending" && !request.messageId)
      return createSendMessageSuccess(original, message, "queued");
  }
  // 账本等待期间目标可能完成、停止或已被另一消息续跑；不能用旧 terminal 快照启动第二个 child。
  const current = registry.get(original.taskId);
  if (
    !isTarget(current) ||
    (!isExplicitlyStoppedTask(original) && isExplicitlyStoppedTask(current))
  ) {
    await ledger?.settle(message.id, "cancelled");
    return createSendMessageFailure(
      request,
      "The member was stopped or belongs to a different conversation branch",
      message.id,
    );
  }
  if (isTerminalRuntimeTask(current)) {
    // 暂时缺失 profile/执行端并不等于消息被消费；保留已接受的 pending 事实供冷恢复。
    return resume(current, message);
  }
  if (current.messageSink) {
    try {
      return createSendMessageSuccess(current, message, await current.messageSink.send(message));
    } catch {
      // sink 退出后只给同一运行补回队列，不能把旧调用排进已经续跑的新执行端。
      const latest = registry.get(current.taskId);
      if (
        isTarget(latest) &&
        latest.status === "running" &&
        latest.traceContext?.spanId === current.traceContext?.spanId
      ) {
        registry.queueMessage(current.taskId, message);
      }
      return createSendMessageSuccess(current, message, "queued");
    }
  }
  registry.queueMessage(current.taskId, message);
  return createSendMessageSuccess(current, message, "queued");
}

function createRuntimeTaskPendingMessage(
  request: SubagentSendMessageRequest,
  namedMember: boolean,
): RuntimeTaskPendingMessage {
  // 不同 child provider 可以复用 toolCallId；发送者必须进入幂等域。队长保持既有 ID 兼容。
  const identity = request.senderAgentId
    ? JSON.stringify([request.sessionId, request.senderAgentId, request.parentToolCallId])
    : `${request.sessionId}:${request.parentToolCallId}`;
  return {
    id:
      request.messageId ??
      (namedMember
        ? `msg_${createHash("sha256").update(identity).digest("hex").slice(0, MESSAGE_ID_HASH_LENGTH)}`
        : `msg_${crypto.randomUUID()}`),
    isMeta: true,
    message: request.senderName
      ? `From teammate ${request.senderName} (${request.senderAgentId}):\n${request.message}`
      : request.message,
    origin: {
      kind: request.senderAgentId ? "member" : "coordinator",
      agentId: request.senderAgentId,
      memberName: request.senderName,
      toolCallId: String(request.parentToolCallId),
    },
    queuedAt: new Date(),
    summary: request.summary,
    traceContext: request.trace,
  };
}

export function createSendMessageSuccess(
  task: Pick<RuntimeTaskSnapshot, "agentId" | "outputFile" | "status" | "taskId">,
  message: RuntimeTaskPendingMessage,
  delivery: NonNullable<SubagentSendMessageResult["delivery"]>,
): SubagentSendMessageResult {
  const providerMessage =
    delivery === "queued"
      ? `Message queued for delivery to ${task.agentId} at its next tool round.`
      : delivery === "resumed_background"
        ? `Agent "${task.agentId}" was stopped (${task.status}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${task.outputFile}`
        : `Message ${message.id} was sent to its active turn for local agent ${task.agentId}.`;
  return {
    status: "success",
    messageId: message.id,
    delivery,
    agentId: task.agentId,
    taskId: task.taskId,
    outputFile: task.outputFile,
    message: providerMessage,
  };
}

export function createSendMessageFailure(
  request: SubagentSendMessageRequest,
  error: string,
  messageId?: string,
): SubagentSendMessageResult {
  return {
    status: "failed",
    messageId: messageId ?? request.messageId ?? `msg_${crypto.randomUUID()}`,
    agentId: request.to,
    error,
    message: error,
  };
}
