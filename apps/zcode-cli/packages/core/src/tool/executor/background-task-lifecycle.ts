// Modified by ZCode Feiyu.
import {
  traceContextToLogContext,
  type SessionEvent,
  type TraceContext,
  type TurnId,
} from "@zcode/contracts";
import { isSubagentDispatchToolName } from "../compat.js";
import type { ExecutableToolCall } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { isRecord } from "./utils.js";

import {
  claimRuntimeBackgroundTaskNotification,
  isDynamicWorkflowRunDispatchToolName,
  releaseRuntimeBackgroundTaskNotification,
} from "./background-task-registry.js";
import { backgroundTaskOutputMetadata } from "./background-task-output.js";

import { formatBackgroundTaskNotification } from "./background-notification-format.js";
import {
  backgroundTaskKind,
  resolveBashBackgroundResultTitle,
  getBackgroundTaskWaiter,
  getWorkflowTaskWaiter,
} from "./background-notification-helpers.js";
import {
  workflowTaskSubject,
  workflowSnapshotTerminal,
  buildWorkflowNotificationOriginMeta,
} from "./background-workflow-notification.js";
import type {
  BackgroundTaskSnapshot,
  BackgroundTaskLifecycleProvider,
} from "./background-task-types.js";
// 生命周期端口分派和通知 claim 沿用 tracker 同一依赖；不复制运行状态。
export class BackgroundTaskLifecycle {
  constructor(protected readonly deps: ToolExecutorDeps) {}

  protected async emitBackgroundTaskEvent(
    type: SessionEvent["type"],
    payload: Record<string, unknown>,
    traceContext: TraceContext,
    turnId: TurnId | undefined,
  ): Promise<void> {
    await this.deps.emitEvent({
      id: crypto.randomUUID() as any,
      sessionId: this.deps.sessionId,
      turnId,
      type,
      timestamp: new Date(),
      traceId: traceContext.traceId,
      sequenceNumber: 0,
      payload,
    });
  }

  protected backgroundTaskPayload(
    toolCall: ExecutableToolCall,
    taskId: string,
    status: string,
    snapshot?: BackgroundTaskSnapshot,
    output?: Record<string, unknown>,
  ): Record<string, unknown> {
    const input = isRecord(toolCall.input) ? toolCall.input : {};
    const outputMetadata = backgroundTaskOutputMetadata(snapshot, output);

    return {
      taskId,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      // V4 projection 过去从 toolName 手写推断类型，漏掉真实 Agent
      // 工具名后把后台 subagent 投成 bash/process。runtime 在事实产生处一次裁决。
      // 生命周期行为不受影响——那已经由 per-tool 的 lifecycleProvider 分派。
      taskKind: backgroundTaskKind(toolCall.name),
      childSessionId: outputMetadata.childSessionId,
      cancellable: status === "running" && this.canCancelBackgroundTask(toolCall),
      command: typeof input.command === "string" ? input.command : undefined,
      // CreateWorkflow 的输入 schema 里没有 `description`（只有 `{name?, script}`，
      // contracts/src/tools/create-workflow.ts），走通用的 input.description → snapshot.description
      // 链会整字段缺席，Workflows 分区的题名于是退到 toolName，每个 run 都显示成
      // "CreateWorkflow"。展示名与完成通知共用同一条兜底链（含 input.name），所以直接复用
      // workflowTaskSubject。它最后一环是 taskId（≡ runId）：投影会把它原样当题名，与缺席时
      // 退 toolName 并不相同——UI 侧约定 title ≡ workId 视同「无名」并换用 fallbackName，
      // 所以这一环到不了用户眼前，同时保住了「description 恒非空」的简单性。
      // dwf 分派名扩到 ResumeWorkflowRun：同一条兜底链（它也只有 run_id，无 description）。
      description: isDynamicWorkflowRunDispatchToolName(toolCall.name)
        ? workflowTaskSubject(toolCall, taskId, snapshot, output)
        : typeof input.description === "string"
          ? input.description
          : snapshot && "description" in snapshot
            ? snapshot.description
            : undefined,
      status,
      pid: snapshot && "pid" in snapshot ? snapshot.pid : undefined,
      startedAt: snapshot?.startedAt,
      completedAt: snapshot?.completedAt,
      outputPath: outputMetadata.outputFile,
      stderrPersistedOutputPath: outputMetadata.stderrFile,
      stdoutPersistedOutputPath: outputMetadata.stdoutFile,
      outputBytes: outputMetadata.outputBytes,
      outputTruncated: outputMetadata.outputTruncated,
      outputTail: outputMetadata.outputTail,
      stderrBytes: outputMetadata.stderrBytes,
      stderrTail: outputMetadata.stderrTail,
      stdoutBytes: outputMetadata.stdoutBytes,
      stdoutTail: outputMetadata.stdoutTail,
      terminalId: taskId,
    };
  }

  protected backgroundSnapshotSignature(snapshot: BackgroundTaskSnapshot): string {
    return JSON.stringify({
      pid: snapshot && "pid" in snapshot ? snapshot.pid : undefined,
      stderrBytes: snapshot && "stderrBytes" in snapshot ? snapshot.stderrBytes : undefined,
      stderrTail: snapshot && "stderrTail" in snapshot ? snapshot.stderrTail : undefined,
      stdoutBytes: snapshot && "stdoutBytes" in snapshot ? snapshot.stdoutBytes : undefined,
      stdoutTail: snapshot && "stdoutTail" in snapshot ? snapshot.stdoutTail : undefined,
    });
  }

  protected canCancelBackgroundTask(toolCall: ExecutableToolCall): boolean {
    return this.lifecycleProvider(toolCall).cancellable === true;
  }

  protected isNotifiedLocalAgentSnapshot(
    toolCall: ExecutableToolCall,
    snapshot: BackgroundTaskSnapshot,
  ): boolean {
    const record = snapshot as unknown as Record<string, unknown>;
    return (
      isSubagentDispatchToolName(toolCall.name) &&
      record.type === "local_agent" &&
      record.notified === true
    );
  }

  protected maybeEnqueueBackgroundTaskNotification(
    toolCall: ExecutableToolCall,
    taskId: string,
    status: string,
    snapshot: BackgroundTaskSnapshot | undefined,
    traceContext: TraceContext,
    output?: Record<string, unknown>,
  ): void {
    if (!this.deps.enqueueBackgroundTaskNotification) {
      this.deps.logger?.debug?.("Background task notification queue unavailable", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.notification.queue_unavailable",
        module: "core.tool.executor",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }

    // 被修订替代的 run 不发终态通知：
    // 停下它的那次 AmendWorkflow 的工具结果就是模型对这次停止的
    // 全部所知，再来一条「你停了 run A，现在去修订它」会把模型送进循环。仍然 claim：让稍后的
    // TaskOutput 读取不把它当成一条没送达的通知。
    if (workflowSnapshotTerminal(status, snapshot)?.stopReason === "superseded") {
      claimRuntimeBackgroundTaskNotification(this.deps, toolCall, taskId);
      this.deps.logger?.info?.("Background task notification suppressed: run superseded", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.notification.suppressed",
        module: "core.tool.executor",
        reason: "workflow_run_superseded",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }

    if (
      this.deps.shouldEnqueueBackgroundTaskNotification?.({
        runtimeScope: this.deps.runtimeScope,
        status,
        taskId,
        toolName: toolCall.name,
        traceContext,
      }) === false
    ) {
      this.deps.logger?.info?.("Background task notification suppressed by runtime policy", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.notification.suppressed",
        module: "core.tool.executor",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }

    const text = formatBackgroundTaskNotification(
      this.deps,
      toolCall,
      taskId,
      status,
      snapshot,
      output,
    );
    if (!text) {
      this.deps.logger?.debug?.("Background task notification skipped without formatted message", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.notification.skipped",
        module: "core.tool.executor",
        reason: "empty_message",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }
    // TaskOutput 读取终态会先把同一 registry task 标成 notified；
    // completion 只有成功 claim 后才能入队，避免模型同时收到 tool result 和重复通知。
    if (!claimRuntimeBackgroundTaskNotification(this.deps, toolCall, taskId)) {
      this.deps.logger?.debug?.("Background task notification already claimed", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.tracking.notification_already_handled",
        module: "core.tool.executor",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }
    try {
      this.deps.enqueueBackgroundTaskNotification({
        ...(toolCall.name === "Bash"
          ? {
              originMeta: {
                backgroundSource: "bash" as const,
                title: resolveBashBackgroundResultTitle(toolCall, taskId),
                workId: taskId,
              },
            }
          : {}),
        // workflow run 的终态回合要渲染成后台结果头，而不是退化成一条裸 model-only 消息，
        // 所以 originMeta 必须带上（workId ≡ runId）。CreateWorkflow 与 ResumeWorkflowRun
        // 两个入口同构（分派见 isDynamicWorkflowRunDispatchToolName）。manifest 载荷
        // （workflowNotification）在此处发射侧铸造：GUI 渲染的唯一数据源，随 originMeta 走全管线。
        ...(isDynamicWorkflowRunDispatchToolName(toolCall.name)
          ? {
              originMeta: buildWorkflowNotificationOriginMeta(
                toolCall,
                taskId,
                status,
                snapshot,
                output,
              ),
            }
          : {}),
        taskId,
        text,
        toolName: toolCall.name,
        traceContext,
      });
    } catch (error) {
      releaseRuntimeBackgroundTaskNotification(this.deps, toolCall, taskId);
      this.deps.logger?.warn("Background task notification enqueue failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        module: "core.tool.executor",
        taskId,
      });
      return;
    }
    this.deps.logger?.info?.("Background task notification enqueued", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.notification.enqueued",
      module: "core.tool.executor",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
  }

  protected hasBackgroundTaskSnapshotProvider(toolCall: ExecutableToolCall): boolean {
    return this.lifecycleProvider(toolCall).getSnapshot !== undefined;
  }

  protected hasDirectBackgroundTaskWaiter(toolCall: ExecutableToolCall): boolean {
    return this.lifecycleProvider(toolCall).waitForTerminal !== undefined;
  }

  protected async waitForBackgroundTaskSnapshot(
    toolCall: ExecutableToolCall,
    taskId: string,
  ): Promise<BackgroundTaskSnapshot | undefined> {
    return this.lifecycleProvider(toolCall).waitForTerminal?.(taskId);
  }

  protected async getBackgroundTaskSnapshot(
    toolCall: ExecutableToolCall,
    taskId: string,
  ): Promise<BackgroundTaskSnapshot | undefined> {
    return this.lifecycleProvider(toolCall).getSnapshot?.(taskId);
  }

  /**
   * 按工具名解析后台生命周期提供者。每个分支只描述"这个工具的四件事分别由哪个端口承担"，
   * 与泛化前的五处 if 一一对应，语义逐字保持。
   */
  protected lifecycleProvider(toolCall: ExecutableToolCall): BackgroundTaskLifecycleProvider {
    const deps = this.deps;

    if (isSubagentDispatchToolName(toolCall.name)) {
      const getTask = deps.subagentPort?.getTask;
      return {
        ...(getTask
          ? { getSnapshot: (taskId: string) => getTask.call(deps.subagentPort, taskId) }
          : {}),
        // 修复原因：background Agent 的停止入口在 subagentPort.stopTask；
        // started payload 不能沿用 Bash 的 executionPort 能力判断。
        cancellable: Boolean(deps.subagentPort?.stopTask),
      };
    }

    if (isDynamicWorkflowRunDispatchToolName(toolCall.name)) {
      // workflow run：快照/等待/取消全部来自窄端口 DynamicWorkflowRunPort（runId ≡ taskId ≡ workId）。
      // 取消能力以 cancel 方法存在为准，而不是硬编码——端口在场即可取消，这正是详情页
      // Cancel 按钮与后台面板停止共用的那条唯一路径的前提。CreateWorkflow（新启动）与
      // ResumeWorkflowRun（恢复）共用同一 provider：registry 条目重臂时经 existing 合并
      // 语义沿用原始工具行的 parentToolCallId，两条入口对 tracker 完全同构。
      const port = deps.dynamicWorkflowRunPort;
      if (port === undefined) return {};
      return {
        getSnapshot: (taskId: string) => port.getTask(taskId),
        ...(typeof port.waitForTask === "function"
          ? { waitForTerminal: (taskId: string) => port.waitForTask(taskId) }
          : {}),
        cancellable: typeof port.cancel === "function",
      };
    }

    if (toolCall.name === "Workflow") {
      // legacy Workflow：只有快照与等待，没有取消——停止入口从未接过（保持泛化前的 false）。
      const getTask = deps.workflowPort?.getTask;
      const waiter = getWorkflowTaskWaiter(deps.workflowPort);
      return {
        ...(getTask
          ? { getSnapshot: (taskId: string) => getTask.call(deps.workflowPort, taskId) }
          : {}),
        ...(waiter ? { waitForTerminal: (taskId: string) => waiter.waitForTask(taskId) } : {}),
        cancellable: false,
      };
    }

    if (toolCall.name === "Bash") {
      const waiter = getBackgroundTaskWaiter(deps.executionPort);
      const getBackgroundTask = deps.executionPort?.getBackgroundTask;
      return {
        ...(getBackgroundTask
          ? { getSnapshot: (taskId: string) => getBackgroundTask.call(deps.executionPort, taskId) }
          : {}),
        ...(waiter
          ? { waitForTerminal: (taskId: string) => waiter.waitForBackgroundTask(taskId) }
          : {}),
        cancellable: Boolean(deps.executionPort?.cancelBackgroundTask),
      };
    }

    // 其余工具沿用 executionPort 的通用后台面（无直接等待者），与泛化前一致。
    const getBackgroundTask = deps.executionPort?.getBackgroundTask;
    return {
      ...(getBackgroundTask
        ? { getSnapshot: (taskId: string) => getBackgroundTask.call(deps.executionPort, taskId) }
        : {}),
      cancellable: Boolean(deps.executionPort?.cancelBackgroundTask),
    };
  }
}
