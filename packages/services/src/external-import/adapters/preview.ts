// Modified by ZCode Feiyu.
import { realpath } from "node:fs/promises";
import type { ExternalImportDetectRequest, ExternalImportDiscovery } from "@zcode/shared";
import { discover } from "./detection.js";
import { loadState } from "./privateState.js";
import { digest } from "./sourceFiles.js";
import { importPathIdentity } from "../domain/identity.js";
export async function detectImportPreview(
  request: ExternalImportDetectRequest,
  options: { directory: string; targetRoot: string },
  signal: AbortSignal,
  requestId: string,
): Promise<ExternalImportDiscovery> {
  const discovery = await discover(request, options.targetRoot, signal);
  const state = await loadState(options.directory);
  for (const item of discovery.sessions) {
    signal.throwIfAborted();
    const target = item.workspacePath
      ? await realpath(item.workspacePath).catch(() => item.workspacePath)
      : "";
    const entry =
      state.mappings[digest(`${item.key}:${importPathIdentity(target, process.platform)}`)];
    if (entry?.revision === item.revision) item.importedTaskId = entry.taskId;
  }
  const cursor = Math.max(0, Math.trunc(request.cursor ?? 0));
  const limit = Math.max(1, Math.min(500, Math.trunc(request.limit ?? 100)));
  const end = cursor + limit;
  return {
    ...discovery,
    source: request.source,
    requestId,
    sessions: discovery.sessions.slice(cursor, end),
    total: discovery.sessions.length,
    ...(end < discovery.sessions.length ? { nextCursor: end } : {}),
  };
}
