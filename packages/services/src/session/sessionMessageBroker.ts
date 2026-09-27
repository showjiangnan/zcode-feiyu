import {
  resolveWorkspaceKey,
  TASK_APP_SERVER_LIMITS,
  type TaskAppOperation,
  type TaskAppError,
} from "@zcode/shared";
import type {
  SessionMessageDeliveryResult,
  SessionMessageSendRequested,
} from "./sessionMailbox.js";

interface TaskMeta {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}
export interface SessionMessageBrokerDeps {
  getTaskMeta(input: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<TaskMeta | null>;
  forward(request: SessionMessageSendRequested): Promise<void> | void;
}
export class SessionMessageRoutingError extends Error {
  constructor(
    readonly code: TaskAppError["code"],
    message: string,
  ) {
    super(message);
  }
}

/** Host 只关联在途 RPC；完成事实由目标 CommandInbox 持久查询，避免缓存过期权限和未知回执。 */
export function createSessionMessageBroker(deps: SessionMessageBrokerDeps) {
  const pending = new Map<
    string,
    {
      resolve: (result: SessionMessageDeliveryResult) => void;
      timeout: ReturnType<typeof setTimeout>;
      request: SessionMessageSendRequested;
    }
  >();
  const inFlight = new Map<
    string,
    { signature: string; promise: Promise<SessionMessageDeliveryResult> }
  >();
  let disposed = false;
  function unknown(
    request: SessionMessageSendRequested,
    message: string,
  ): SessionMessageDeliveryResult {
    return {
      requestId: request.requestId,
      messageId: request.messageId,
      sessionId: request.fromSessionId,
      status: "unknown",
      error: message,
      ...(request.operation
        ? {
            response: {
              ok: false as const,
              requestId: request.requestId,
              error: { code: "result_unknown" as const, message, retryable: true },
            },
          }
        : {}),
    };
  }
  function send(input: {
    content: string;
    fromSessionId: string;
    requestId: string;
    toSessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    operation?: TaskAppOperation;
  }): Promise<SessionMessageDeliveryResult> {
    if (disposed)
      return Promise.reject(
        new SessionMessageRoutingError("unavailable", "Task message broker is closed."),
      );
    const signature = JSON.stringify([
      resolveWorkspaceKey(input),
      input.fromSessionId,
      input.toSessionId,
      input.content,
      input.operation,
    ]);
    const existing = inFlight.get(input.requestId);
    if (existing)
      return existing.signature === signature
        ? existing.promise
        : Promise.reject(
            new SessionMessageRoutingError(
              "invalid_request",
              "Request ID was reused for a different operation.",
            ),
          );
    if (
      inFlight.size >= TASK_APP_SERVER_LIMITS.maxPendingRequests &&
      input.operation?.type !== "cancelWait"
    )
      return Promise.reject(
        new SessionMessageRoutingError("overloaded", "Too many task service requests."),
      );
    const promise = sendOnce(input).finally(() => inFlight.delete(input.requestId));
    inFlight.set(input.requestId, { signature, promise });
    return promise;
  }
  async function sendOnce(
    input: Parameters<typeof send>[0],
  ): Promise<SessionMessageDeliveryResult> {
    if (input.fromSessionId === input.toSessionId && !input.operation)
      throw new SessionMessageRoutingError(
        "forbidden",
        "Cannot send a task message to the current task.",
      );
    if (!input.content.trim() && !input.operation)
      throw new SessionMessageRoutingError("invalid_request", "Task message content is empty.");
    if (input.content.length > TASK_APP_SERVER_LIMITS.maxMessageChars)
      throw new SessionMessageRoutingError("invalid_request", "Task message is too large.");
    if (
      input.operation &&
      "taskId" in input.operation &&
      input.operation.taskId !== input.toSessionId
    )
      throw new SessionMessageRoutingError(
        "invalid_request",
        "Operation target differs from its route.",
      );
    const target = {
      workspacePath: input.workspacePath,
      workspaceIdentity: input.workspaceIdentity,
    };
    const [sourceMeta, targetMeta] = await Promise.all([
      deps.getTaskMeta({ ...target, taskId: input.fromSessionId }),
      deps.getTaskMeta({ ...target, taskId: input.toSessionId }),
    ]);
    if (disposed)
      throw new SessionMessageRoutingError("unavailable", "Task message broker is closed.");
    const key = resolveWorkspaceKey(target);
    if (!sourceMeta || resolveWorkspaceKey(sourceMeta) !== key)
      throw new SessionMessageRoutingError(
        "forbidden",
        "Source task is not in this local workspace.",
      );
    if (!targetMeta || resolveWorkspaceKey(targetMeta) !== key)
      throw new SessionMessageRoutingError(
        "not_found",
        "Target task is not in this local workspace.",
      );
    const request: SessionMessageSendRequested = {
      content: input.content,
      createdAt: new Date().toISOString(),
      fromSessionId: input.fromSessionId,
      messageId: input.requestId,
      requestId: input.requestId,
      toSessionId: input.toSessionId,
      workspacePath: targetMeta.workspacePath,
      ...(targetMeta.workspaceIdentity ? { workspaceIdentity: targetMeta.workspaceIdentity } : {}),
      ...(input.operation ? { operation: input.operation } : {}),
    };
    return new Promise((resolve, reject) => {
      // Main 超时和 Host 失联都不证明输入未接收；保留原 ID 供后续向 CLI 对账。
      const timeout = setTimeout(() => {
        pending.delete(input.requestId);
        resolve(unknown(request, "Task message delivery result timed out."));
      }, 35_000);
      pending.set(input.requestId, { resolve, timeout, request });
      Promise.resolve()
        .then(() => deps.forward(request))
        .catch((error: unknown) => {
          clearTimeout(timeout);
          pending.delete(input.requestId);
          reject(error);
        });
    });
  }
  function acceptResult(result: SessionMessageDeliveryResult): void {
    const waiter = pending.get(result.requestId);
    if (
      !waiter ||
      waiter.request.fromSessionId !== result.sessionId ||
      waiter.request.messageId !== result.messageId
    )
      return;
    pending.delete(result.requestId);
    clearTimeout(waiter.timeout);
    waiter.resolve(result);
  }
  return {
    send,
    acceptResult,
    dispose() {
      disposed = true;
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timeout);
        waiter.resolve(
          unknown(waiter.request, "Source Host closed before its result was confirmed."),
        );
      }
      pending.clear();
    },
  };
}
