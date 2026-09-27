import type { TaskAppRequest, TaskAppResult, TaskAppRead } from "@zcode/shared";
import type { CommandEnvelope, CommandAck } from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeTaskService } from "#src/session/zcodeTaskService.js";
import type { IZCodeAgentService, ZCodeAgentWorkspaceTarget } from "./zcodeAgent.js";
import { createHostCommandEnvelope, ZCodeV4CommandRejectedError } from "./zcodeV4HostCommand.js";
import { TaskServiceError } from "./taskAppServiceError.js";

/** 所有协作写入都复用现有任务服务或 V4 admission，禁止另造输入队列。 */
export async function executeTaskAppCommand(input: {
  request: TaskAppRequest;
  workspace: ZCodeAgentWorkspaceTarget;
  agent: IZCodeAgentService;
  tasks: () => IZCodeTaskService;
  read: () => Promise<TaskAppRead>;
  query: (commandId: string) => Promise<{ ack: CommandAck | null }>;
  adoptSession(taskId: string): Promise<void>;
}): Promise<TaskAppResult> {
  const { request, workspace, agent, read, query } = input;
  const deps = { tasks: input.tasks };
  const op = request.operation;
  const taskId = "taskId" in op ? op.taskId : request.sourceSessionId;
  const command = async (envelope: CommandEnvelope): Promise<TaskAppResult> => {
    const ack = await agent.sendConversationCommandV4({ ...workspace, envelope });
    // V4 对迟到 Stop 使用 noop 防误停；协作调用者需要明确知道观察到的 execution 已失效。
    if (envelope.type === "stop" && ack.reasonCode === "guard.stopTargetChanged")
      throw new TaskServiceError("stale", "The observed execution is no longer current.");
    if (!["accepted", "duplicate", "noop"].includes(ack.status))
      throw new ZCodeV4CommandRejectedError(envelope.type, ack, "Task service command rejected");
    return { type: "command", taskId, commandId: envelope.commandId, ack };
  };
  if (op.type === "create") {
    const ack = await agent.sendConversationCommandV4({
      ...workspace,
      envelope: createHostCommandEnvelope({
        type: "createSession",
        sessionId: null,
        commandId: request.requestId,
        payload: { workspaceId: workspace.workspacePath },
      }),
    });
    if (!["accepted", "duplicate"].includes(ack.status) || ack.result?.type !== "createSession")
      throw new TaskServiceError(
        "rejected",
        ack.message ?? "Task creation did not return a session.",
      );
    const created = ack.result.sessionId;
    await input.adoptSession(created);
    if (op.title) await deps.tasks().renameTask({ ...workspace, taskId: created, title: op.title });
    return { type: "command", taskId: created, commandId: request.requestId, ack };
  }
  if (
    op.type === "rename" ||
    op.type === "archive" ||
    op.type === "unarchive" ||
    op.type === "resume" ||
    op.type === "close"
  ) {
    if (op.type === "rename")
      await deps.tasks().renameTask({ ...workspace, taskId, title: op.title });
    if (op.type === "archive") await deps.tasks().archiveTask({ ...workspace, taskId });
    if (op.type === "unarchive") await deps.tasks().unarchiveTask({ ...workspace, taskId });
    if (op.type === "resume") await read();
    if (op.type === "close") {
      await read();
      if (!(await agent.closeSession({ ...workspace, sessionId: taskId, onlyIfIdle: true })))
        throw new TaskServiceError(
          "stale",
          "Target has active or queued work; stop the observed execution first.",
        );
    }
    return { type: "command", taskId, commandId: request.requestId };
  }
  if (op.type === "send") {
    const commandId = op.retryCommandId ?? request.requestId;
    if (op.retryCommandId) {
      const prior = await query(commandId);
      if (prior.ack) {
        if (!["accepted", "duplicate", "noop"].includes(prior.ack.status))
          throw new ZCodeV4CommandRejectedError(
            "sendText",
            prior.ack,
            "Original command was rejected",
          );
        return { type: "command", taskId, commandId, ack: prior.ack };
      }
    }
    // legacy resumeTask 的索引 hint 会丢失 reasoning options；V4 hydration 保持目标完整选型。
    await read();
    return command(
      createHostCommandEnvelope({
        type: "sendText",
        sessionId: taskId,
        commandId,
        payload: {
          text: op.message,
          requestedDelivery: op.delivery === "queue" ? "queue" : "guide",
          heldQueueDisposition: "keepQueueAndSend",
          interTaskSourceTaskId: request.sourceSessionId,
        },
      }),
    );
  }
  // 所有写入经过原 V4 admission/guard，控制参数不能越过目标 runtime 的裁决。
  const observed = await read();
  if (op.type === "stop")
    return command(
      createHostCommandEnvelope({
        type: "stop",
        sessionId: taskId,
        commandId: request.requestId,
        payload: { expectedForegroundExecutionId: op.expectedForegroundExecutionId },
      }),
    );
  if (op.type === "compact")
    return command(
      createHostCommandEnvelope({
        type: "compact",
        sessionId: taskId,
        commandId: request.requestId,
        payload: {},
      }),
    );
  if (op.type === "cancelInput")
    return command(
      createHostCommandEnvelope({
        type: "deleteQueueItem",
        sessionId: taskId,
        commandId: request.requestId,
        baseRevision: observed.history.atRevision,
        payload: { queueItemId: `queue_${op.commandId}` },
      }),
    );
  if (op.type === "fork") {
    const result = await command(
      createHostCommandEnvelope({
        type: "forkAssistant",
        sessionId: taskId,
        commandId: request.requestId,
        payload: { target: op.target },
        baseRevision: op.baseRevision,
        baseLogEpoch: op.baseLogEpoch,
      }),
    );
    const ack = (result as { ack?: CommandAck }).ack;
    if (ack?.result?.type === "forkAssistant") {
      await input.adoptSession(ack.result.sessionId);
      return { ...result, taskId: ack.result.sessionId } as TaskAppResult;
    }
    return result;
  }
  throw new TaskServiceError("invalid_request", "Unsupported task operation.");
}
