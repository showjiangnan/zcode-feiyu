import {
  resolveWorkspaceKey,
  taskAppRequestSchema,
  taskAppResponseSchema,
  TASK_APP_SERVER_LIMITS,
  type TaskAppRequest,
  type TaskAppResponse,
  type TaskAppResult,
  type TaskAppRead,
  type TaskAppError,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import { createHash } from "node:crypto";
import type { IZCodeTaskService } from "#src/session/zcodeTaskService.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { waitForTaskObservation } from "#src/session/taskObservation.js";
import type { IZCodeAgentService, ZCodeAgentWorkspaceTarget } from "./zcodeAgent.js";
import { createZCodeAgentConnectionScope } from "./zcodeAgentConnectionScope.js";
import { ZCodeV4CommandRejectedError } from "./zcodeV4HostCommand.js";

import { TaskServiceError } from "./taskAppServiceError.js";
import { executeTaskAppCommand } from "./taskAppCommands.js";

type Workspace = Pick<ZCodeAgentWorkspaceTarget, "workspacePath" | "workspaceIdentity">;
const summary = (task: ZCodeTaskMeta, archived: boolean) => ({
  taskId: task.taskId,
  title: task.title,
  status: task.status ?? "unknown",
  archived,
});
const OPERATIONS = [
  "capabilities",
  "list",
  "create",
  "read",
  "send",
  "query",
  "wait",
  "cancelWait",
  "resume",
  "rename",
  "archive",
  "unarchive",
  "close",
  "compact",
  "stop",
  "cancelInput",
  "fork",
];

/** 本地任务应用接口；事实只读 CLI，生命周期复用已有 task service。 */
export function createTaskAppService(deps: {
  agent: IZCodeAgentService;
  tasks: () => IZCodeTaskService;
  index: TaskIndexRepo;
  adoptSession(workspace: Workspace, taskId: string): Promise<void>;
}) {
  const waits = new Map<
    string,
    { controller: AbortController; source: string; taskId: string; workspaceKey: string }
  >();
  let disposed = false;
  const ownCommand = (source: string, commandId: string) => {
    if (
      !commandId.startsWith(`task-app:${source}:`) &&
      !commandId.startsWith(`task-message:${source}:`)
    )
      throw new TaskServiceError(
        "forbidden",
        "Only commands originating from this task may be queried or cancelled.",
      );
  };
  async function execute(workspace: Workspace, raw: TaskAppRequest): Promise<TaskAppResponse> {
    let requestId = raw.requestId;
    let observation: { controller: AbortController; lifecycle?: { dispose(): void } } | undefined;
    try {
      const request = taskAppRequestSchema.parse(raw);
      requestId = request.requestId;
      if (disposed) throw new TaskServiceError("unavailable", "Task service has closed.");
      ownCommand(request.sourceSessionId, request.requestId);
      const op = request.operation;
      if (op.type === "cancelWait") {
        ownCommand(request.sourceSessionId, op.waitRequestId);
        const waiter = waits.get(op.waitRequestId);
        if (
          waiter &&
          waiter.source === request.sourceSessionId &&
          waiter.taskId === op.taskId &&
          waiter.workspaceKey === resolveWorkspaceKey(workspace)
        )
          waiter.controller.abort();
        return {
          ok: true,
          requestId,
          result: { type: "command", taskId: op.taskId, commandId: requestId },
        };
      }
      if (op.type === "wait") {
        if (waits.size >= TASK_APP_SERVER_LIMITS.maxPendingRequests)
          throw new TaskServiceError("overloaded", "Too many task observers.");
        if (waits.has(requestId))
          throw new TaskServiceError("invalid_request", "Observation is already pending.");
        // 在第一个异步校验之前登记，避免 cancel 先返回、迟到 wait 又留下孤儿观察者。
        const controller = new AbortController();
        waits.set(requestId, {
          controller,
          source: request.sourceSessionId,
          taskId: op.taskId,
          workspaceKey: resolveWorkspaceKey(workspace),
        });
        observation = {
          controller,
          lifecycle: deps.agent.onAgentRuntimeLifecycle?.((event) => {
            if (
              event.workspaceKey === resolveWorkspaceKey(workspace) &&
              event.state === "unavailable"
            )
              controller.abort(new TaskServiceError("unavailable", "Target runtime exited."));
          }),
        };
      }
      const source = await deps
        .tasks()
        .getTaskMeta({ ...workspace, taskId: request.sourceSessionId });
      if (!source || resolveWorkspaceKey(source) !== resolveWorkspaceKey(workspace))
        throw new TaskServiceError("forbidden", "Source task is outside this workspace.");
      if ("taskId" in op) {
        if (op.taskId === request.sourceSessionId)
          throw new TaskServiceError("forbidden", "Target must be another top-level task.");
        const target = await deps.tasks().getTaskMeta({ ...workspace, taskId: op.taskId });
        if (!target || resolveWorkspaceKey(target) !== resolveWorkspaceKey(workspace))
          throw new TaskServiceError("not_found", "Target task is unavailable in this workspace.");
      }
      if ("commandId" in op && op.commandId) ownCommand(request.sourceSessionId, op.commandId);
      if (op.type === "send" && op.retryCommandId)
        ownCommand(request.sourceSessionId, op.retryCommandId);
      if (disposed) throw new TaskServiceError("unavailable", "Task service has closed.");
      observation?.controller.signal.throwIfAborted();
      const result = await run(workspace, request);
      return taskAppResponseSchema.parse({ ok: true, requestId, result });
    } catch (error) {
      let code: TaskAppError["code"] = "result_unknown";
      if (error instanceof TaskServiceError) code = error.code;
      else if (error instanceof ZCodeV4CommandRejectedError)
        code =
          error.ack.reasonCode === "fault.command.queryUnavailable"
            ? "result_unknown"
            : error.ack.status === "stale"
              ? "stale"
              : "rejected";
      else if (error instanceof Error && error.name === "ZodError") code = "invalid_request";
      else if (error instanceof Error && error.name === "AbortError") code = "cancelled";
      return {
        ok: false,
        requestId,
        error: {
          code,
          message: error instanceof Error ? error.message : String(error),
          retryable: ["result_unknown", "unavailable", "overloaded"].includes(code),
        },
      };
    } finally {
      if (observation) {
        observation.lifecycle?.dispose();
        waits.delete(requestId);
      }
    }
  }
  async function run(workspace: Workspace, request: TaskAppRequest): Promise<TaskAppResult> {
    const op = request.operation;
    if (op.type === "capabilities")
      return {
        type: "capabilities",
        version: 1,
        scope: "desktop-local-workspace",
        operations: OPERATIONS,
        maxPageSize: TASK_APP_SERVER_LIMITS.maxPageSize,
        maxWaitMs: TASK_APP_SERVER_LIMITS.maxWaitMs,
        maxPendingRequests: TASK_APP_SERVER_LIMITS.maxPendingRequests,
        maxMessageChars: TASK_APP_SERVER_LIMITS.maxMessageChars,
        permissions: { approveOtherTask: false, changeOtherTaskModel: false },
      };
    if (op.type === "list") {
      let after = "";
      const filter = JSON.stringify([
        resolveWorkspaceKey(workspace),
        op.search ?? "",
        op.archived ?? false,
      ]);
      if (op.cursor) {
        try {
          const value = JSON.parse(Buffer.from(op.cursor, "base64url").toString());
          if (value.filter !== filter || typeof value.after !== "string") throw new Error();
          after = value.after;
        } catch {
          throw new TaskServiceError("invalid_request", "Task cursor does not match this list.");
        }
      }
      const limit = op.limit ?? TASK_APP_SERVER_LIMITS.pageSize;
      const tasks = await deps.index.queryTaskPage({
        ...workspace,
        archived: op.archived ?? false,
        excludeTaskId: request.sourceSessionId,
        afterTaskId: after,
        search: op.search ?? "",
        limit: limit + 1,
      });
      const items = tasks.slice(0, limit);
      return {
        type: "list",
        tasks: items.map((task) => summary(task, op.archived ?? false)),
        nextCursor:
          tasks.length > items.length
            ? Buffer.from(JSON.stringify({ filter, after: items.at(-1)!.taskId })).toString(
                "base64url",
              )
            : null,
      };
    }
    const scope = createZCodeAgentConnectionScope(deps.agent, {
      connectionId: `task-service:${createHash("sha256").update(request.requestId).digest("hex")}`,
      clientMode: "desktop-continuous",
      role: "trusted-host-relay",
    });
    const agent = scope.service;
    const taskId = "taskId" in op ? op.taskId : request.sourceSessionId;
    const target = { ...workspace, sessionId: taskId };
    const read = async (): Promise<TaskAppRead> => {
      const history = await agent.conversationRowsRangeV4({
        ...target,
        limit: op.type === "read" ? (op.limit ?? 50) : 50,
        ...(op.type === "read" && op.beforeRowId !== undefined
          ? { beforeRowId: op.beforeRowId }
          : {}),
      });
      const meta = await deps.tasks().getTaskMeta({ ...workspace, taskId });
      if (!meta) throw new TaskServiceError("not_found", "Task was removed.");
      const archived = await deps.index.getTaskArchivedState({ ...workspace, taskId });
      if (archived === null) throw new TaskServiceError("not_found", "Task was removed.");
      return {
        task: summary(meta, archived),
        cursor: `${history.atLogEpoch}:${history.atSeq}:${meta.updatedAt}:${archived}`,
        history,
      };
    };
    const query = async (commandId: string) => {
      // cold query 必须先经过现有 hydration；不能把尚未装载的持久命令误判为 unknown。
      await agent.conversationRowsRangeV4({ ...target, limit: 1 });
      const response = await agent.queryConversationCommandsV4({
        ...workspace,
        commands: [{ sessionId: taskId, commandId }],
        includeExecution: true,
      });
      const item = response.results[0]!;
      if (item.result !== "unknown" && item.result.reasonCode === "fault.command.queryUnavailable")
        throw new TaskServiceError(
          "result_unknown",
          "The target command ledger is temporarily unavailable.",
        );
      return {
        ack: item.result === "unknown" ? null : item.result,
        ...(item.execution ? { execution: item.execution } : {}),
      };
    };
    try {
      if (op.type === "read") return { type: "read", ...(await read()) };
      if (op.type === "query")
        return { type: "query", commandId: op.commandId, ...(await query(op.commandId)) };
      if (op.type === "wait") {
        const controller = waits.get(request.requestId)!.controller;
        const wakeListeners = new Set<() => void>();
        const frames = agent.onDynamicConversationFrame(workspace)(() => {
          for (const wake of wakeListeners) wake();
        });
        const taskEvents = deps.tasks().onDynamicTaskEvent({ ...workspace, taskId })(() => {
          for (const wake of wakeListeners) wake();
        });
        try {
          await agent.subscribeConversationV4({ ...target, visibility: "background" });
          const waited = await waitForTaskObservation({
            read: async () => ({
              ...(await read()),
              ...(op.commandId ? await query(op.commandId) : {}),
            }),
            subscribe: (wake) => {
              wakeListeners.add(wake);
              return {
                dispose() {
                  wakeListeners.delete(wake);
                },
              };
            },
            ready: (value) => {
              if (
                "execution" in value &&
                value.execution &&
                ["succeeded", "interrupted", "failed", "cancelled"].includes(value.execution.state)
              )
                return "terminal";
              const observation = value.history.observation;
              if (observation?.pendingInteractions.length) return "needs_input";
              if (!op.commandId && (!op.afterCursor || value.cursor !== op.afterCursor))
                return "changed";
              return undefined;
            },
            timeoutMs: op.timeoutMs ?? 10_000,
            signal: controller.signal,
          });
          return { type: "wait", ...waited.value, reason: waited.reason };
        } finally {
          frames.dispose();
          taskEvents.dispose();
        }
      }
      // 必须等写入完成再进入 finally；直接返回 Promise 会提前关闭受信连接。
      return await executeTaskAppCommand({
        request,
        workspace,
        agent,
        read,
        query,
        tasks: deps.tasks,
        adoptSession: (taskId) => deps.adoptSession(workspace, taskId),
      });
    } finally {
      await scope.dispose();
    }
  }
  return {
    execute,
    dispose() {
      disposed = true;
      for (const waiter of waits.values())
        waiter.controller.abort(new TaskServiceError("unavailable", "Host task service closed."));
      waits.clear();
    },
  };
}
