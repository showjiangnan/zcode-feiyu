// Modified by ZCode Feiyu contributors (2026).
import {
  zcodeProtocolMethods,
  zcodeTaskMessageListResultSchema,
  zcodeTaskMessageSendResultSchema,
  taskAppResponseSchema,
} from "@zcode/shared";
import type { TaskMessagePort } from "@zcode/contracts";
import { isTaskListSessionType } from "../zcode-protocol-v4/task-list-session-membership.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";

export function createProtocolTaskMessagePort(
  context: ZCodeProtocolAgentServerContext,
  resolveOwnSession: () => ZCodeProtocolSessionRecord | undefined,
): TaskMessagePort {
  function ownSessionId(): string {
    const record = resolveOwnSession();
    const id = record?.app.sessionId;
    if (!id || !isTaskListSessionType(record?.taskType))
      throw new Error("Task messaging requires an active top-level session.");
    return id;
  }
  return {
    async request(input, signal) {
      const sourceSessionId = ownSessionId();
      // 只信发送 runtime 在此刻已消费的输入；不能让工具或旧请求自行盖因果深度。
      const causalContext = resolveOwnSession()?.app.runtime?.getProactiveCausalContext();
      const operation =
        input.operation.type === "send" ? { ...input.operation, causalContext } : input.operation;
      const cancel = () => {
        if (input.operation.type !== "wait") return;
        // 取消等待是独立只读控制，不发送 stop，不撤销 B 已接收的输入。
        void context
          .requestClient(
            zcodeProtocolMethods.interactionTaskService,
            {
              sourceSessionId,
              requestId: `${input.requestId}:cancel`,
              operation: {
                type: "cancelWait",
                taskId: input.operation.taskId,
                waitRequestId: input.requestId,
              },
            },
            taskAppResponseSchema,
          )
          .catch(() => undefined);
      };
      signal?.throwIfAborted();
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        return await context.requestClient(
          zcodeProtocolMethods.interactionTaskService,
          { ...input, sourceSessionId, operation },
          taskAppResponseSchema,
        );
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    },
    async list() {
      const result = await context.requestClient(
        zcodeProtocolMethods.interactionListWorkspaceTasks,
        { sourceSessionId: ownSessionId() },
        zcodeTaskMessageListResultSchema,
      );
      return result.tasks;
    },
    async send(input) {
      return context.requestClient(
        zcodeProtocolMethods.interactionSendTaskMessage,
        {
          sourceSessionId: ownSessionId(),
          targetTaskId: input.targetTaskId,
          requestId: input.requestId,
          message: input.message,
        },
        zcodeTaskMessageSendResultSchema,
      );
    },
  };
}
