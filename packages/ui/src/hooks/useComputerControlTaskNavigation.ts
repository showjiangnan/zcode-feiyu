// Modified by ZCode Feiyu contributors (2026).
import { useCallback } from "react";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

export function useComputerControlTaskNavigation(
  workspacePath: string,
  workspaceIdentity?: string,
) {
  const metadata = useTaskQueryCacheStore((state) => state.taskMetaByEntityKey);
  const taskLabel = useCallback(
    (sessionId: string) => {
      const key = buildTaskEntityKey({
        taskId: sessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      return metadata[key]?.title || sessionId.slice(0, 16);
    },
    [metadata, workspacePath, workspaceIdentity],
  );
  const returnToTask = useCallback(
    (sessionId: string) => {
      useZCodeSessionStore.getState().setActiveTaskId(workspacePath, sessionId, workspaceIdentity);
    },
    [workspacePath, workspaceIdentity],
  );
  return { taskLabel, returnToTask };
}
