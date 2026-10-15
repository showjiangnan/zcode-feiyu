// Modified by ZCode Feiyu.
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, posix, win32, sep } from "node:path";
import { createHash } from "node:crypto";
import type { ExternalImportCandidate, ExternalImportSource } from "@zcode/shared";
import { importPathIdentity } from "../domain/identity.js";
import { HistoryBuilder, object, text } from "../domain/history.js";
import { consumeResponseRecord } from "../domain/responseHistory.js";
import { consumeProjectRecord } from "../domain/projectHistory.js";

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function defaultSourceRoot(source: ExternalImportSource): string {
  return source === "codex"
    ? process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")
    : process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}
export async function containedPath(root: string, path: string): Promise<string> {
  const [base, target] = await Promise.all([realpath(root), realpath(path)]);
  const part = relative(base, target);
  if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part))
    throw new Error("source_path_escape");
  return target;
}
export async function walkFiles(
  root: string,
  extension: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const files: string[] = [];
  async function walk(path: string): Promise<void> {
    signal?.throwIfAborted();
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.isSymbolicLink()) continue;
      const child = join(path, entry.name);
      if (
        entry.isDirectory() &&
        !["subagents", "worktrees", "worktree", "node_modules", ".git"].includes(entry.name)
      )
        await walk(child);
      else if (entry.isFile() && entry.name.endsWith(extension)) files.push(child);
    }
  }
  await walk(root);
  return files;
}
export async function readSource(
  source: ExternalImportSource,
  root: string,
  path: string,
  signal?: AbortSignal,
  options: { end?: number; ancestors?: Set<string> } = {},
): Promise<{
  candidate: ExternalImportCandidate;
  messages: import("@zcode/shared").ExternalHistoryMessage[];
}> {
  const file = await containedPath(root, path);
  const info = await stat(file);
  const builder = new HistoryBuilder(info.birthtimeMs || info.mtimeMs);
  let lineNumber = 0;
  let pendingError: Error | undefined;
  const ancestors = new Set(options.ancestors);
  if (ancestors.has(file)) throw new Error("source_parent_cycle");
  ancestors.add(file);
  const stream = createReadStream(file, {
    encoding: "utf8",
    ...(options.end !== undefined ? { end: options.end - 1 } : {}),
  });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const abort = () => stream.destroy(new Error("cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const line of reader) {
      signal?.throwIfAborted();
      lineNumber++;
      if (!line.trim()) continue;
      if (pendingError) throw pendingError;
      let record;
      try {
        record = object(JSON.parse(line));
      } catch {
        pendingError = new Error(`invalid_jsonl:${lineNumber}`);
        continue;
      }
      (source === "codex" ? consumeResponseRecord : consumeProjectRecord)(
        builder,
        record,
        lineNumber,
      );
      if (source === "codex" && record.type === "session_meta") {
        const base = object(object(record.payload).history_base);
        const parentId = text(base.thread_id);
        const end = Number(base.end_byte_offset);
        if (parentId && Number.isSafeInteger(end) && end > 0) {
          try {
            const paths = [
              ...(await walkFiles(join(root, "sessions"), ".jsonl", signal)),
              ...(await walkFiles(join(root, "archived_sessions"), ".jsonl", signal)),
            ];
            const parentPath = paths.find((value) => basename(value).endsWith(`${parentId}.jsonl`));
            if (!parentPath) throw new Error("source_parent_missing");
            if (end > (await stat(parentPath)).size) throw new Error("source_parent_incomplete");
            const parent = await readSource(source, root, parentPath, signal, { end, ancestors });
            for (const message of parent.messages) builder.add(message);
            for (const message of parent.messages)
              for (const block of message.blocks)
                if (block.type === "tool") builder.calls.set(block.callId, block);
            builder.warnings.delete("source_history_base_requires_available_parent");
            for (const warning of parent.candidate.warnings) builder.warnings.add(warning);
          } catch (error) {
            signal?.throwIfAborted();
            builder.warnings.add(error instanceof Error ? error.message : "source_parent_missing");
          }
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.close();
    stream.destroy();
  }
  if (pendingError) {
    builder.warnings.add("incomplete_tail_deferred");
    builder.running = true;
  }
  const after = await stat(file);
  if (after.size !== info.size || after.mtimeMs !== info.mtimeMs)
    throw new Error("source_changed_rescan_required");
  builder.finalize();
  if (builder.child) throw new Error("child_session_excluded");
  if (!builder.messages.length) throw new Error("empty_history");
  const sessionId = builder.sessionId || basename(path, ".jsonl");
  const first = builder.messages[0];
  const last = builder.messages.at(-1)!;
  const revision = digest(
    JSON.stringify({
      messages: builder.messages,
      title: builder.title,
      workspacePath: builder.workspacePath,
    }),
  );
  const key = digest(
    `${source}:${importPathIdentity(await realpath(root), process.platform)}:${sessionId}`,
  );
  const candidate: ExternalImportCandidate = {
    key,
    revision,
    source,
    sessionId,
    title:
      builder.title ||
      builder.messages.find((m) => m.role === "user")?.content.slice(0, 100) ||
      "Imported session",
    // Windows isAbsolute 也接受 / 开头的 POSIX 路径；必须优先保留原 Unix 路径格式。
    workspacePath: posix.isAbsolute(builder.workspacePath)
      ? posix.normalize(builder.workspacePath)
      : win32.isAbsolute(builder.workspacePath)
        ? win32.normalize(builder.workspacePath)
        : "",
    sourcePath: file,
    createdAt: first?.timestamp || info.birthtimeMs,
    updatedAt: last.timestamp || info.mtimeMs,
    archived: relative(root, path).split(sep).includes("archived_sessions"),
    running: builder.running,
    messageCount: builder.messages.length,
    warnings: [...builder.warnings],
  };
  return { candidate, messages: builder.messages };
}
