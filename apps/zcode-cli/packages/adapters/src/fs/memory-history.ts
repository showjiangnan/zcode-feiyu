// Modified by ZCode Feiyu contributors (2026).
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FileSystemWriteTextRequest } from "@zcode/contracts";
import { withSecureMemoryFile, type SecureMemoryContent } from "./secure-memory-file.js";
import { memoryRevision } from "./memory-files.js";

export interface MemoryHistoryEntry {
  operationId: string;
  rootDir: string;
  path: string;
  sourceSessionId: string;
  before: string | null;
  after: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  state: "prepared" | "committed" | "aborted" | "conflict";
  createdAt: number;
}
type HistoryRow = { record: string; state: MemoryHistoryEntry["state"] };
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const stale = (message: string) => Object.assign(new Error(message), { code: "ESTALE" });

async function openHistory(directory: string): Promise<DatabaseSync> {
  await mkdir(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, "history.sqlite"), { timeout: 5_000 });
  db.exec(`pragma journal_mode=WAL; pragma synchronous=FULL;
    create table if not exists memory_mutation (operation_id text primary key, root_dir text not null,
      path text not null, created_at integer not null, state text not null, record text not null);
    create index if not exists memory_mutation_root on memory_mutation(root_dir, created_at);`);
  return db;
}

async function recoverPrepared(db: DatabaseSync, rootDir: string): Promise<void> {
  const rows = db
    .prepare("select record, state from memory_mutation where root_dir = ? and state = 'prepared'")
    .all(rootDir) as unknown as HistoryRow[];
  for (const row of rows) {
    const entry = JSON.parse(row.record) as MemoryHistoryEntry;
    let actual: string | null = null;
    try {
      actual = await withSecureMemoryFile(
        rootDir,
        entry.path,
        false,
        async (file) => (await file.read()).hash,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    const state =
      actual === entry.afterHash
        ? "committed"
        : actual === entry.beforeHash
          ? "aborted"
          : "conflict";
    db.prepare(
      "update memory_mutation set state = ? where operation_id = ? and state = 'prepared'",
    ).run(state, entry.operationId);
  }
}

export async function recoverMemoryHistory(directory: string, rootDir: string): Promise<void> {
  const db = await openHistory(directory);
  try {
    await recoverPrepared(db, rootDir);
  } finally {
    db.close();
  }
}

export async function commitMemoryHistory(
  directory: string,
  request: FileSystemWriteTextRequest,
  signal?: AbortSignal,
): Promise<SecureMemoryContent>;
export async function commitMemoryHistory(
  directory: string,
  request: FileSystemWriteTextRequest,
  signal: AbortSignal | undefined,
  remove: true,
): Promise<null>;
export async function commitMemoryHistory(
  directory: string,
  request: FileSystemWriteTextRequest,
  signal?: AbortSignal,
  remove = false,
): Promise<SecureMemoryContent | null> {
  const scope = request.memoryCommit;
  if (!scope) throw new Error("Memory write requires a commit fence");
  if (!remove && request.content.includes("\0"))
    throw new Error("Memory mutation requires UTF-8 text");
  const db = await openHistory(directory);
  try {
    return await scope.guard(async () => {
      scope.fence?.assertHeld();
      signal?.throwIfAborted();
      // 下次受控写入先对账旧预写记录；历史真实性不能依赖用户打开历史面板。
      await recoverPrepared(db, scope.rootDir);
      return withSecureMemoryFile(
        scope.rootDir,
        request.path,
        request.createParents === true,
        async (file) => {
          let before: SecureMemoryContent | undefined;
          try {
            before = await file.read();
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
          }
          if (before?.bytes) {
            // 历史保存可撤回的 UTF-8 正文；二进制不能经有损解码后被工具覆盖。
            try {
              new TextDecoder("utf-8", { fatal: true }).decode(before.bytes);
            } catch {
              throw new Error("Memory mutation requires UTF-8 text");
            }
            if (before.bytes.includes(0)) throw new Error("Memory mutation requires UTF-8 text");
          }
          const existing = db
            .prepare("select record,state from memory_mutation where operation_id=?")
            .get(scope.operationId) as HistoryRow | undefined;
          const after = remove ? null : request.content;
          if (existing) {
            const original = JSON.parse(existing.record) as MemoryHistoryEntry;
            if (
              original.rootDir !== scope.rootDir ||
              original.path !== request.path ||
              original.sourceSessionId !== scope.sourceSessionId ||
              original.after !== after
            ) {
              throw stale("Memory operation identity changed");
            }
            if (existing.state === "committed") {
              if ((before?.hash ?? null) !== original.afterHash)
                throw stale("Memory changed after committed operation");
              return remove ? null : before!;
            }
            if (existing.state === "conflict")
              throw stale("Memory operation has a recovery conflict");
          }
          if (
            (request.expectedAbsent && before) ||
            (request.expectedRevision &&
              (!before ||
                (request.expectedRevision.hash
                  ? request.expectedRevision.hash !== before.hash
                  : request.expectedRevision.id !== memoryRevision(before).id)))
          ) {
            throw stale("Memory revision changed");
          }
          const entry: MemoryHistoryEntry = {
            operationId: scope.operationId,
            rootDir: scope.rootDir,
            path: request.path,
            sourceSessionId: scope.sourceSessionId,
            before: before?.content ?? null,
            after,
            beforeHash: before?.hash ?? null,
            afterHash: remove ? null : hash(request.content),
            state: "prepared",
            createdAt: Date.now(),
          };
          if (existing) {
            const original = JSON.parse(existing.record) as MemoryHistoryEntry;
            if (entry.beforeHash !== original.beforeHash)
              throw stale("Memory changed before replay");
            db.prepare("update memory_mutation set state='prepared' where operation_id=?").run(
              scope.operationId,
            );
          } else {
            db.prepare("insert into memory_mutation values (?, ?, ?, ?, 'prepared', ?)").run(
              entry.operationId,
              entry.rootDir,
              entry.path,
              entry.createdAt,
              JSON.stringify(entry),
            );
          }
          signal?.throwIfAborted();
          scope.fence?.assertHeld();
          const result = remove
            ? (before && (await file.remove(before.hash, signal)), null)
            : await file.replace(request.content, before?.hash, !before, signal);
          db.prepare("update memory_mutation set state = 'committed' where operation_id = ?").run(
            entry.operationId,
          );
          return result;
        },
      );
    });
  } finally {
    db.close();
  }
}

export async function listMemoryHistory(
  directory: string,
  rootDir: string,
  before?: { createdAt: number; operationId: string },
  limit = 50,
  summariesOnly = false,
): Promise<MemoryHistoryEntry[]> {
  const db = await openHistory(directory);
  try {
    const rows = db
      .prepare(`select ${summariesOnly ? "json_remove(record,'$.before','$.after')" : "record"} as record, state from memory_mutation where root_dir = ? and (created_at < ? or (created_at = ? and operation_id < ?))
      order by created_at desc, operation_id desc limit ?`)
      .all(
        rootDir,
        before?.createdAt ?? Number.MAX_SAFE_INTEGER,
        before?.createdAt ?? Number.MAX_SAFE_INTEGER,
        before?.operationId ?? "",
        Math.min(100, Math.max(1, limit)),
      ) as unknown as HistoryRow[];
    return rows.map((row) => ({
      ...(JSON.parse(row.record) as MemoryHistoryEntry),
      state: row.state,
    }));
  } finally {
    db.close();
  }
}

export async function readMemoryHistory(
  directory: string,
  rootDir: string,
  operationId: string,
): Promise<MemoryHistoryEntry | null> {
  const db = await openHistory(directory);
  try {
    const row = db
      .prepare("select record, state from memory_mutation where root_dir=? and operation_id=?")
      .get(rootDir, operationId) as HistoryRow | undefined;
    return row ? { ...(JSON.parse(row.record) as MemoryHistoryEntry), state: row.state } : null;
  } finally {
    db.close();
  }
}
