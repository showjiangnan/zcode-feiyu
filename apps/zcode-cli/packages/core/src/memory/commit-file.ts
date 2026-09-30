// Modified by ZCode Feiyu contributors (2026).
import { randomUUID } from "node:crypto";
import type { FileSystemWriteTextRequest, FileSystemWriteTextResult } from "@zcode/contracts";
import type { ToolExecutionContext } from "../tool/types.js";
import { resolveContainedMemoryFilePath } from "./memory-file-path.js";
import { withProjectMemoryWriteLease } from "./write-lease.js";

/** 主会话、提取与整理使用同一写入口；最终文件替换在持久 owner fencing 内执行。 */
export async function commitMemoryAwareFile(
  context: ToolExecutionContext,
  request: FileSystemWriteTextRequest,
): Promise<FileSystemWriteTextResult> {
  const fileSystem = context.fileSystemPort!;
  const rootDir = context.memoryRoot;
  if (
    !rootDir ||
    !resolveContainedMemoryFilePath({
      filePath: request.path,
      rootDir,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
    })
  ) {
    return fileSystem.writeTextFile(request, { signal: context.abortSignal });
  }
  return withProjectMemoryWriteLease({
    sessionStore: context.sessionStore,
    workspaceKey: rootDir,
    signal: context.abortSignal,
    operation: (signal, guard) =>
      fileSystem.writeTextFile(
        {
          ...request,
          memoryCommit: {
            rootDir,
            operationId: randomUUID(),
            sourceSessionId: context.sessionId,
            guard,
            // 原因：写租约的 ownerId/epoch 每次提交重新申请，只凭它无法证明调用方（如整理任务）自己的
            // 租约仍然有效。把调用方栅栏带入提交点，由写租约排他事务在文件替换前复核调用方 epoch，
            // 修复旧 owner 在续租后、提交前恢复写入仍可覆盖新修订的问题。
            ...(context.memoryOwnershipFence ? { fence: context.memoryOwnershipFence } : {}),
          },
        },
        { signal },
      ),
  });
}
