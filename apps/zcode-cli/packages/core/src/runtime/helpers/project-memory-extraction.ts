// Modified by ZCode Feiyu contributors (2026).
import { selectActiveConversationBranch, type TraceContext } from "../deps.js";
import {
  buildMemoryExtractionPrompt,
  createMemoryExtractionScheduler,
  type MemoryExtractionScheduler,
  type MemoryExtractionSnapshot,
} from "../../memory/extraction.js";
import { runMemoryAgentLoop } from "../../memory/memory-agent-loop.js";
import { assertMemoryToolPathSafe } from "../../memory/tool-path-guard.js";
import { scanMemoryManifest } from "../../memory/recall/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  buildProjectMemoryAgentProviderMessages,
  captureProjectMemoryAgentContext,
  createProjectMemoryAgentToolExecutor,
  type ProjectMemoryAgentContext,
} from "./project-memory-agent.js";
import { resolveEnabledProjectMemoryRoot } from "./project-memory.js";
import { memoryBatchInput, memoryBatchSettlement } from "./project-memory-batch.js";
import {
  continuityBackgroundWorkTitle,
  settleContinuityBackgroundWork,
  startContinuityBackgroundWork,
} from "./continuity-background-work.js";

const EXTRACTION_DRAIN_TIMEOUT_MS = 60_000;

interface ProjectMemoryExtractionSnapshot
  extends MemoryExtractionSnapshot, ProjectMemoryAgentContext {}

export type ProjectMemoryExtractionScheduler =
  MemoryExtractionScheduler<ProjectMemoryExtractionSnapshot>;

export function isProjectMemoryEnabled(this: AgentRuntimeInternal): boolean {
  return resolveEnabledProjectMemoryRoot(this.config, this.workspaceRoot) !== undefined;
}

export function scheduleProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: { model: ProjectMemoryAgentContext["model"]; traceContext: TraceContext },
): void {
  if (runtime.shuttingDown) return;
  // 原因：headless 只关闭自动 Extraction，必须在读取快照或访问文件前返回，避免后台副作用。
  if (runtime.config.memory?.extractionEnabled === false) return;
  // Bash cd 只改变执行 cwd，project Memory 身份必须继续使用会话 workspace root。
  const memoryRoot = resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot);
  if (!memoryRoot) return;
  if (runtime.isRemoteWorkspace()) return;
  if (!runtime.sessionStore || !runtime.fileSystemPort) return;

  const snapshotBase = captureProjectMemoryAgentContext(runtime, {
    memoryRoot,
    model: input.model,
    operation: "project_memory_extract",
    traceContext: input.traceContext,
  });
  const snapshotBoundaryMessageId = runtime.latestConversationMessageId;
  if (!snapshotBoundaryMessageId) return;
  const durableMessages = runtime.sessionStore.messages({ sessionID: runtime.sessionId });
  const session = runtime.sessionStore.getSession(runtime.sessionId);
  const snapshot = Promise.all([durableMessages, session]).then(
    ([messages, scheduledSession]): ProjectMemoryExtractionSnapshot => {
      const activeMessages = selectActiveConversationBranch(messages, {
        branchCutAfterMessageId: scheduledSession?.revert?.branchCutAfterMessageID,
        rewindCreatedMessageId: scheduledSession?.revert?.createdMessageID,
        rewindKeptMessageIds: scheduledSession?.revert?.keptMessageIDs,
        rewindTargetMessageId: scheduledSession?.revert?.targetMessageID,
      });
      const boundaryIndex = activeMessages.findIndex(
        (message) => message.info.id === snapshotBoundaryMessageId,
      );
      if (boundaryIndex < 0) {
        throw new Error("Extraction boundary is missing from the scheduled active branch");
      }
      return {
        ...snapshotBase,
        boundaryMessageId: snapshotBoundaryMessageId,
        durableMessages: activeMessages.slice(0, boundaryIndex + 1),
      };
    },
  );

  const store = runtime.sessionStore;
  runtime.memoryExtractionScheduler ??= createMemoryExtractionScheduler(
    async (extraction) => {
      const fileSystem = runtime.fileSystemPort!;
      if (!fileSystem.runMemoryBatch) throw new Error("Durable memory extraction is unavailable");
      // 抽屉条目由**这个所有者**发出（复审 GAP-03）：workId 绑定边界消息，同一轮重复调度是幂等的；
      // 条目只在运行期间存在，终态由投影移除（见 continuity-background-work.ts 的说明）。
      const workId = `${runtime.sessionId}:memory-extraction:${extraction.snapshot.boundaryMessageId}`;
      const title = continuityBackgroundWorkTitle({
        kind: "memory_extraction",
        language: runtime.config.language,
      });
      const workTraceContext = extraction.snapshot.traceContext;
      await startContinuityBackgroundWork(
        runtime,
        { kind: "memory_extraction", title, workId },
        workTraceContext,
      );
      try {
        const result = await fileSystem.runMemoryBatch(
          memoryBatchInput(runtime, memoryRoot, extraction.snapshot.boundaryMessageId),
          async () => {
            const status = await executeProjectMemoryExtraction(runtime, extraction);
            if (status !== "success") throw new Error(`Memory extraction ${status}`);
            return status;
          },
          memoryBatchSettlement(runtime, memoryRoot, extraction.abortSignal),
        );
        await settleContinuityBackgroundWork(
          runtime,
          { kind: "memory_extraction", status: "completed", title, workId },
          workTraceContext,
        );
        return result ?? "success";
      } catch (error) {
        // 取消与失败分开报告：中止信号来自抽屉的停止入口或会话关闭，那是一次取消而不是故障。
        await settleContinuityBackgroundWork(
          runtime,
          {
            kind: "memory_extraction",
            status: extraction.abortSignal.aborted ? "cancelled" : "failed",
            title,
            workId,
          },
          workTraceContext,
        );
        throw error;
      }
    },
    store.readProjectMemoryExtractionCursor && store.advanceProjectMemoryExtractionCursor
      ? {
          loadCursor: async () => {
            await runtime.fileSystemPort!.recoverMemoryBatches?.(
              runtime.sessionId,
              memoryBatchSettlement(runtime, memoryRoot),
            );
            return store.readProjectMemoryExtractionCursor!(runtime.sessionId);
          },
          advanceCursor: (expectedCursor, nextCursor) =>
            store.advanceProjectMemoryExtractionCursor!({
              sessionId: runtime.sessionId,
              expectedCursor,
              nextCursor,
              now: Date.now(),
            }),
        }
      : undefined,
  );
  runtime.memoryExtractionScheduler.schedule(snapshot);
}

export async function drainMemoryExtractions(
  this: AgentRuntimeInternal,
  timeoutMs: number | null = EXTRACTION_DRAIN_TIMEOUT_MS,
): Promise<void> {
  const scheduler = this.memoryExtractionScheduler;
  if (!scheduler) return;
  // benchmark 显式等待自然结束；普通 session close 仍保留原有有界取消清理。
  if (timeoutMs === null) {
    await scheduler.drain();
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      scheduler.drain(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function executeProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal: AbortSignal;
    messageCount: number;
    snapshot: ProjectMemoryExtractionSnapshot;
  },
) {
  const telemetry = runtime.agentTelemetry.detached({
    causation: input.snapshot.causation,
    executionKind: "background",
    operation: "project_memory_extract",
    targetKind: "project_memory",
    traceContext: input.snapshot.traceContext,
    trigger: "scheduler",
  });

  return telemetry.run(async () => {
    try {
      const manifest = await scanMemoryManifest({
        fileSystem: runtime.fileSystemPort!,
        rootDir: input.snapshot.memoryRoot,
        signal: input.abortSignal,
      });
      if (input.abortSignal.aborted) {
        telemetry.finishCancelled("abort_signal");
        return "aborted" as const;
      }
      const prompt = buildMemoryExtractionPrompt({
        manifest,
        messageCount: input.messageCount,
      });
      const providerMessages = buildProjectMemoryAgentProviderMessages(
        runtime,
        input.snapshot,
        prompt,
      );
      const executor = createProjectMemoryAgentToolExecutor(runtime, input.snapshot);

      const result = await runMemoryAgentLoop({
        abortSignal: input.abortSignal,
        executeTool: async (toolCall, options) => {
          const execute = async (signal?: AbortSignal) => {
            await assertMemoryToolPathSafe({
              fileSystem: runtime.fileSystemPort,
              rootDir: input.snapshot.memoryRoot,
              toolCall,
              workingDirectory: input.snapshot.workingDirectory,
              workspaceRoot: input.snapshot.workspaceRoot,
            });
            return executor.execute(toolCall, {
              signal,
              traceContext: input.snapshot.traceContext,
            });
          };
          return execute(options.abortSignal);
        },
        messages: providerMessages,
        model: input.snapshot.model,
        rootDir: input.snapshot.memoryRoot,
        tools: input.snapshot.tools,
        workingDirectory: input.snapshot.workingDirectory,
        workspaceRoot: input.snapshot.workspaceRoot,
      });
      if (!result.completed || result.toolErrors > 0) {
        throw new Error("Memory extraction did not complete cleanly");
      }
      telemetry.finishCompleted();
      return "success" as const;
    } catch (error) {
      if (input.abortSignal.aborted || isAbortError(error)) {
        telemetry.finishCancelled("abort_signal");
        return "aborted" as const;
      }
      telemetry.finishFailed("execute", "internal", error);
      return "error" as const;
    }
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
