// Modified by ZCode Feiyu contributors (2026).
import { createHash } from "node:crypto";
import {
  isTaskRoot,
  PROJECT_MEMORY_BATCH_CANCELLED_CODE,
  selectActiveConversationBranch,
  type MemoryBatchInput,
  type MemoryBatchSettlement,
  type MessageId,
  type SessionId,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { withProjectMemoryWriteLease } from "../../memory/write-lease.js";
import { resolveEnabledProjectMemoryRoot } from "./project-memory.js";

export async function recoverProjectMemoryWorkspace(runtime: AgentRuntimeInternal): Promise<void> {
  if (runtime.memoryRecoveryTask) return runtime.memoryRecoveryTask;
  const rootDir = resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot);
  const store = runtime.sessionStore;
  const fileSystem = runtime.fileSystemPort;
  if (
    !rootDir ||
    !store?.withProjectMemoryWriteFence ||
    !fileSystem ||
    runtime.isRemoteWorkspace() ||
    runtime.shuttingDown
  )
    return;
  const controller = new AbortController();
  runtime.memoryRecoveryAbortController = controller;
  const task = (async () => {
    if (fileSystem.recoverMemoryHistory) {
      await withProjectMemoryWriteLease({
        sessionStore: store,
        workspaceKey: rootDir,
        signal: controller.signal,
        operation: (_signal, guard) => guard(() => fileSystem.recoverMemoryHistory!(rootDir)),
      });
    }
    // 省略 extractionEnabled 的旧 Runtime 与调度器保持一致，仅显式 false 关闭。
    if (
      runtime.config.memory?.extractionEnabled === false ||
      !store.advanceProjectMemoryExtractionCursor ||
      !fileSystem.recoverWorkspaceMemoryBatches
    )
      return;
    const result = await fileSystem.recoverWorkspaceMemoryBatches(
      rootDir,
      memoryBatchSettlement(runtime, rootDir, controller.signal),
    );
    if (result.failedOperationIds.length)
      runtime.logger?.warn("Project memory recovery has unresolved batches", {
        sessionId: runtime.sessionId,
        failedBatches: result.failedOperationIds.length,
      });
  })().catch((error: unknown) => {
    if (!controller.signal.aborted) throw error;
  });
  runtime.memoryRecoveryTask = task;
  try {
    await task;
  } finally {
    if (runtime.memoryRecoveryTask === task) runtime.memoryRecoveryTask = undefined;
    if (runtime.memoryRecoveryAbortController === controller)
      runtime.memoryRecoveryAbortController = undefined;
  }
}

export function memoryBatchInput(
  runtime: AgentRuntimeInternal,
  rootDir: string,
  boundaryMessageId: string,
): MemoryBatchInput {
  return {
    rootDir,
    boundaryMessageId,
    sessionId: runtime.sessionId,
    operationId: createHash("sha256")
      .update(`${runtime.sessionId}:${boundaryMessageId}`)
      .digest("hex"),
  };
}

export function memoryBatchSettlement(
  runtime: AgentRuntimeInternal,
  rootDir: string,
  signal?: AbortSignal,
): MemoryBatchSettlement {
  const store = runtime.sessionStore!;
  const assertAllowed = () => {
    signal?.throwIfAborted();
    if (!runtime.config.memory?.enabled || runtime.config.memory.extractionEnabled === false)
      throw new Error("Memory extraction permission revoked");
  };
  const isCurrent: MemoryBatchSettlement["isCurrent"] = async (batch) => {
    const sessionId = batch.sessionId as SessionId;
    const [session, messages] = await Promise.all([
      store.getSession(sessionId),
      store.messages({ sessionID: sessionId }),
    ]);
    const workspaceKey =
      runtime.config.memory?.workspaceIdentity?.trim() ||
      runtime.config.workspacePath ||
      runtime.workspaceRoot;
    if (
      !session ||
      (!isTaskRoot(session.taskType, session.parentID) &&
        session.taskType !== "selection_side_chat") ||
      (session.workspaceID?.trim() || session.directory) !== workspaceKey ||
      batch.rootDir !== rootDir
    )
      return false;
    const active = selectActiveConversationBranch(messages, {
      branchCutAfterMessageId: session.revert?.branchCutAfterMessageID,
      rewindCreatedMessageId: session.revert?.createdMessageID,
      rewindKeptMessageIds: session.revert?.keptMessageIDs,
      rewindTargetMessageId: session.revert?.targetMessageID,
    });
    return active.some((message) => message.info.id === batch.boundaryMessageId);
  };
  const assertCurrent = async (batch: MemoryBatchInput) => {
    if (!(await isCurrent(batch)))
      throw Object.assign(new Error(`Memory batch cancelled: ${batch.operationId}`), {
        code: PROJECT_MEMORY_BATCH_CANCELLED_CODE,
      });
    assertAllowed();
  };
  return {
    assertAllowed,
    isCurrent,
    commit: async (request, source) => {
      if (!source) throw new Error("Memory batch commit requires its original source");
      assertAllowed();
      return withProjectMemoryWriteLease({
        sessionStore: store,
        workspaceKey: rootDir,
        signal,
        operation: (leaseSignal, guard) =>
          runtime.fileSystemPort!.writeTextFile(
            {
              ...request,
              memoryCommit: {
                rootDir,
                operationId: source.operationId,
                sourceSessionId: source.batch.sessionId,
                guard: (commit) =>
                  guard(async () => {
                    // 初次 isCurrent 后可跨文件 IO/等待租约发生撤回；必须在 setRevert 共用屏障内复核。
                    await assertCurrent(source.batch);
                    return commit();
                  }),
              },
            },
            { signal: leaseSignal },
          ),
      });
    },
    settleCursor: async (batch) => {
      assertAllowed();
      if (!store.withProjectMemoryExtractionFence)
        throw new Error("Project memory extraction fence is unavailable");
      const sessionId = batch.sessionId as SessionId;
      await store.withProjectMemoryExtractionFence(sessionId, async (cursor) => {
        // 先验证分支再处理幂等；否则已写文件/同边界游标会绕过撤回后的取消事实。
        await assertCurrent(batch);
        const expectedCursor = await cursor.read();
        if (expectedCursor === batch.boundaryMessageId) return;
        if (expectedCursor) {
          const messages = await store.messages({ sessionID: sessionId });
          const currentIndex = messages.findIndex((message) => message.info.id === expectedCursor);
          const boundaryIndex = messages.findIndex(
            (message) => message.info.id === batch.boundaryMessageId,
          );
          // 恢复旧批次只能补齐游标，不能把较新的成功边界回退。
          if (currentIndex >= 0 && boundaryIndex >= 0 && currentIndex > boundaryIndex) return;
        }
        assertAllowed();
        const accepted = await cursor.advance({
          expectedCursor,
          nextCursor: batch.boundaryMessageId as MessageId,
          now: Date.now(),
        });
        if (!accepted && (await cursor.read()) !== batch.boundaryMessageId)
          throw new Error("Memory extraction cursor changed during recovery");
      });
    },
  };
}
