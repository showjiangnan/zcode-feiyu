// Modified by ZCode Feiyu contributors (2026).
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import {
  isFileSystemPortError,
  PROJECT_MEMORY_BATCH_CANCELLED_CODE,
  type FileSystemWriteTextRequest,
  type FileSystemWriteTextResult,
  type MemoryBatchInput,
  type MemoryBatchRecoveryResult,
  type MemoryBatchSettlement,
} from "@zcode/contracts";
import { withSecureMemoryFile, type SecureMemoryContent } from "./secure-memory-file.js";
import { memoryRevision } from "./memory-files.js";

type StagedWrite = Omit<FileSystemWriteTextRequest, "memoryCommit" | "trace"> & {
  beforeHash?: string | null;
  afterHash?: string;
};
interface BatchRecord {
  input: MemoryBatchInput;
  writes: StagedWrite[];
}
type BatchState = "prepared" | "committed" | "settled" | "conflict" | "cancelled";
interface BatchRow {
  operation_id: string;
  state: BatchState;
  record: string;
}
interface Stage {
  input: MemoryBatchInput;
  writes: Map<string, StagedWrite>;
  values: Map<string, SecureMemoryContent>;
}
const hash = (content: string) => `sha256:${createHash("sha256").update(content).digest("hex")}`;

/** 提取工作副本只属于当前调用；持久提交意图一旦准备就不能被下一次模型结果覆盖。 */
export class MemoryBatchCoordinator {
  private readonly active = new AsyncLocalStorage<Stage>();
  constructor(private readonly directory: string) {}

  read(path: string): SecureMemoryContent | undefined {
    return this.active.getStore()?.values.get(path);
  }
  stagedPaths(directory: string): string[] {
    return [...(this.active.getStore()?.values.keys() ?? [])].filter(
      (path) => dirname(path) === directory,
    );
  }

  async stage(request: FileSystemWriteTextRequest): Promise<FileSystemWriteTextResult | undefined> {
    const stage = this.active.getStore();
    if (!stage || request.memoryCommit?.rootDir !== stage.input.rootDir) return;
    const previous = stage.writes.get(request.path);
    const { memoryCommit: _scope, trace: _trace, ...requestValue } = request;
    const write: StagedWrite = { ...requestValue, afterHash: hash(request.content) };
    if (previous) {
      write.expectedRevision = previous.expectedRevision;
      write.expectedAbsent = previous.expectedAbsent;
      write.beforeHash = previous.beforeHash;
    } else if (write.expectedAbsent) {
      write.beforeHash = null;
    } else if (write.expectedRevision?.hash) {
      write.beforeHash = write.expectedRevision.hash;
    } else {
      // 未带 hash 的内部调用也冻结旧正文，恢复不能把缺省修订解释为任意覆盖。
      const before = await this.readCurrent(stage.input.rootDir, request.path);
      if (
        write.expectedRevision &&
        (!before || memoryRevision(before).id !== write.expectedRevision.id)
      ) {
        throw Object.assign(new Error("Memory batch revision conflict"), { code: "ESTALE" });
      }
      write.beforeHash = before?.hash ?? null;
      if (before) write.expectedRevision = memoryRevision(before);
      else write.expectedAbsent = true;
    }
    stage.writes.set(request.path, write);
    const value = {
      content: request.content,
      size: Buffer.byteLength(request.content),
      mtimeMs: Date.now(),
      hash: write.afterHash!,
    };
    stage.values.set(request.path, value);
    return { path: request.path, bytesWritten: value.size, revision: memoryRevision(value) };
  }

  private async open(): Promise<DatabaseSync> {
    await mkdir(this.directory, { recursive: true });
    const db = new DatabaseSync(join(this.directory, "batches.sqlite"), { timeout: 5_000 });
    db.exec(`pragma journal_mode=WAL; pragma synchronous=FULL;
      create table if not exists memory_batch (operation_id text primary key, session_id text not null,
        state text not null, record text not null, error text, updated_at integer not null);`);
    return db;
  }

  async run<T>(
    input: MemoryBatchInput,
    operation: () => Promise<T>,
    settlement: MemoryBatchSettlement,
  ): Promise<T | undefined> {
    const existing = await this.withLock(settlement, async () => {
      const db = await this.open();
      try {
        const row = this.readRow(db, input.operationId);
        if (!row) return false;
        this.assertSameInput(row, input);
        await this.recoverRow(db, row, settlement);
        return true;
      } finally {
        db.close();
      }
    });
    if (existing) return;

    const stage: Stage = { input, writes: new Map(), values: new Map() };
    const result = await this.active.run(stage, operation);
    settlement.assertAllowed?.();
    await this.withLock(settlement, async () => {
      const db = await this.open();
      try {
        // 并发计算的败者复用胜者的提交意图，不得改写已有 prepared/committed 记录。
        db.prepare(`insert into memory_batch values (?, ?, 'prepared', ?, null, ?)
          on conflict(operation_id) do nothing`).run(
          input.operationId,
          input.sessionId,
          JSON.stringify({ input, writes: [...stage.writes.values()] }),
          Date.now(),
        );
        const row = this.readRow(db, input.operationId)!;
        this.assertSameInput(row, input);
        await this.recoverRow(db, row, settlement);
      } finally {
        db.close();
      }
    });
    return result;
  }

  async recover(sessionId: string, settlement: MemoryBatchSettlement): Promise<void> {
    await this.withLock(settlement, async () => {
      const db = await this.open();
      try {
        const rows = db
          .prepare(
            "select * from memory_batch where session_id=? and state in ('prepared','committed') order by updated_at, operation_id",
          )
          .all(sessionId) as unknown as BatchRow[];
        for (const row of rows) await this.recoverRow(db, row, settlement);
      } finally {
        db.close();
      }
    });
  }

  async recoverWorkspace(
    rootDir: string,
    settlement: MemoryBatchSettlement,
  ): Promise<MemoryBatchRecoveryResult> {
    return this.withLock(settlement, async () => {
      const db = await this.open();
      const result: MemoryBatchRecoveryResult = { recovered: 0, failedOperationIds: [] };
      try {
        const rows = db
          .prepare(`select * from memory_batch where json_extract(record,'$.input.rootDir')=?
          and state in ('prepared','committed') order by updated_at, operation_id`)
          .all(rootDir) as unknown as BatchRow[];
        for (const row of rows) {
          settlement.assertAllowed?.();
          try {
            await this.recoverRow(db, row, settlement);
            result.recovered += 1;
          } catch {
            result.failedOperationIds.push(row.operation_id);
          }
        }
        return result;
      } finally {
        db.close();
      }
    });
  }

  private async withLock<T>(
    settlement: MemoryBatchSettlement,
    operation: () => Promise<T>,
  ): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lock = new DatabaseSync(join(this.directory, "batch-recovery.sqlite"), { timeout: 0 });
    let locked = false;
    const deadline = Date.now() + 30_000;
    try {
      while (!locked) {
        settlement.assertAllowed?.();
        try {
          lock.exec("begin exclusive");
          locked = true;
        } catch (error) {
          const code =
            error && typeof error === "object" && "errcode" in error ? error.errcode : undefined;
          if ((code !== 5 && code !== 6) || Date.now() >= deadline) throw error;
          await delay(20);
        }
      }
      const result = await operation();
      lock.exec("commit");
      locked = false;
      return result;
    } finally {
      if (locked) lock.exec("rollback");
      lock.close();
    }
  }

  private readRow(db: DatabaseSync, operationId: string): BatchRow | undefined {
    return db.prepare("select * from memory_batch where operation_id=?").get(operationId) as
      | BatchRow
      | undefined;
  }

  private assertSameInput(row: BatchRow, input: MemoryBatchInput): void {
    const saved = (JSON.parse(row.record) as BatchRecord).input;
    if (
      saved.sessionId !== input.sessionId ||
      saved.boundaryMessageId !== input.boundaryMessageId ||
      saved.rootDir !== input.rootDir
    ) {
      throw new Error("Memory batch identity changed");
    }
  }

  private async readCurrent(
    rootDir: string,
    path: string,
  ): Promise<SecureMemoryContent | undefined> {
    try {
      return await withSecureMemoryFile(rootDir, path, false, (file) => file.read());
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
        throw error;
      return undefined;
    }
  }

  private async recoverRow(
    db: DatabaseSync,
    row: BatchRow,
    settlement: MemoryBatchSettlement,
  ): Promise<void> {
    if (row.state === "settled") return;
    if (row.state === "conflict" || row.state === "cancelled")
      throw Object.assign(
        new Error(`Memory batch ${row.state}: ${row.operation_id}`),
        row.state === "cancelled" ? { code: PROJECT_MEMORY_BATCH_CANCELLED_CODE } : {},
      );
    settlement.assertAllowed?.();
    const batch = JSON.parse(row.record) as BatchRecord;
    let state = row.state;
    try {
      if (!(await settlement.isCurrent(batch.input)))
        throw Object.assign(new Error(`Memory batch cancelled: ${row.operation_id}`), {
          code: PROJECT_MEMORY_BATCH_CANCELLED_CODE,
        });
      if (state === "prepared") {
        for (const write of batch.writes) {
          settlement.assertAllowed?.();
          const current = await this.readCurrent(batch.input.rootDir, write.path);
          const afterHash = write.afterHash ?? hash(write.content);
          if (afterHash !== hash(write.content))
            throw Object.assign(new Error("Memory batch content hash changed"), { code: "ESTALE" });
          if (current?.hash === afterHash) continue;
          const expected = write.expectedRevision;
          if (
            (write.beforeHash !== undefined && (current?.hash ?? null) !== write.beforeHash) ||
            (write.expectedAbsent && current) ||
            (!write.expectedAbsent && !expected) ||
            (expected &&
              (!current ||
                (expected.hash
                  ? current.hash !== expected.hash
                  : memoryRevision(current).id !== expected.id)))
          ) {
            throw Object.assign(new Error("Memory batch revision conflict"), { code: "ESTALE" });
          }
          const { beforeHash: _beforeHash, afterHash: _afterHash, ...request } = write;
          await settlement.commit(request, {
            batch: batch.input,
            operationId: `batch:${batch.input.operationId}:${createHash("sha256").update(write.path).digest("hex")}`,
          });
        }
        db.prepare(
          "update memory_batch set state='committed', error=null, updated_at=? where operation_id=?",
        ).run(Date.now(), row.operation_id);
        state = "committed";
      }
      // committed 之后只补游标；重读/重写文件会覆盖另一有效 owner 随后的更新。
      settlement.assertAllowed?.();
      await settlement.settleCursor(batch.input);
      db.prepare(
        "update memory_batch set state='settled', error=null, updated_at=? where operation_id=?",
      ).run(Date.now(), row.operation_id);
    } catch (error) {
      // FileSystemPort 保留 guard 原错误为 cause；只解包已约定的分支取消，不把 IO/abort 当终态。
      const cause = isFileSystemPortError(error) ? error.cause : undefined;
      const failure =
        cause &&
        typeof cause === "object" &&
        "code" in cause &&
        cause.code === PROJECT_MEMORY_BATCH_CANCELLED_CODE
          ? cause
          : error;
      const code =
        failure && typeof failure === "object" && "code" in failure ? failure.code : undefined;
      const stale = code === "ESTALE" || code === "stale_write";
      // 最终 guard/游标栅栏可能才发现撤回；不能把终态取消重新记成 prepared 后重复恢复。
      const nextState =
        code === PROJECT_MEMORY_BATCH_CANCELLED_CODE ? "cancelled" : stale ? "conflict" : state;
      db.prepare("update memory_batch set state=?, error=?, updated_at=? where operation_id=?").run(
        nextState,
        failure instanceof Error ? failure.message : String(failure),
        Date.now(),
        row.operation_id,
      );
      throw failure;
    }
  }
}
