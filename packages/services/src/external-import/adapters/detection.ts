// Modified by ZCode Feiyu.
import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import type { ExternalImportCandidate, ExternalImportDetectRequest } from "@zcode/shared";
import { defaultSourceRoot, readSource, walkFiles } from "./sourceFiles.js";
import { detectResources } from "./resources.js";

export async function discover(
  request: ExternalImportDetectRequest,
  targetRoot: string,
  signal: AbortSignal,
) {
  const requestedRoot = resolve(request.root?.trim() || defaultSourceRoot(request.source));
  const warnings: string[] = [];
  const sessions: ExternalImportCandidate[] = [];
  let root: string;
  try {
    root = await realpath(requestedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { root: requestedRoot, sessions, resources: [], warnings: ["source_not_found"] };
    throw error;
  }
  const branches =
    request.source === "codex"
      ? ["sessions", ...(request.includeArchived ? ["archived_sessions"] : [])]
      : ["projects"];
  const titles = new Map<string, string>();
  if (request.source === "codex") {
    try {
      for (const line of (await readFile(join(root, "session_index.jsonl"), "utf8")).split(
        /\r?\n/u,
      )) {
        try {
          const value = JSON.parse(line) as { id?: string; thread_name?: string };
          if (value.id && value.thread_name) titles.set(value.id, value.thread_name);
        } catch {
          /* 索引不是历史真值，尾行错误不阻断读取完整会话。 */
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push("source_index_unavailable");
    }
  }
  const seen = new Set<string>();
  for (const branch of branches)
    for (const path of await walkFiles(join(root, branch), ".jsonl", signal)) {
      signal.throwIfAborted();
      try {
        const { candidate } = await readSource(request.source, root, path, signal);
        if (request.modifiedSince && candidate.updatedAt < request.modifiedSince) continue;
        if (titles.has(candidate.sessionId)) candidate.title = titles.get(candidate.sessionId)!;
        if (
          request.query &&
          !`${candidate.title} ${candidate.workspacePath}`
            .toLocaleLowerCase()
            .includes(request.query.toLocaleLowerCase())
        )
          continue;
        if (!seen.has(candidate.key)) {
          seen.add(candidate.key);
          sessions.push(candidate);
        }
      } catch (error) {
        signal.throwIfAborted();
        const reason = error instanceof Error ? error.message : "source_read_failed";
        if (reason !== "child_session_excluded" && reason !== "empty_history")
          warnings.push(reason);
      }
    }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
  const resources = await detectResources(request.source, root, targetRoot, signal);
  for (const workspacePath of new Set(sessions.map((item) => item.workspacePath).filter(Boolean))) {
    const projectRoot = join(workspacePath, request.source === "codex" ? ".codex" : ".claude");
    if (await directoryExists(workspacePath)) {
      const projectResources = await detectResources(
        request.source,
        projectRoot,
        join(workspacePath, ".zcode"),
        signal,
        workspacePath,
      );
      resources.push(...projectResources);
    }
  }
  return { root, sessions, resources, warnings };
}
export async function directoryExists(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}
