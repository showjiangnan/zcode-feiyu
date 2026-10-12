// Modified by ZCode Feiyu.
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import type { WorkspaceHookTrustRecord, WorkspaceHookTrustStoreFile } from "@zcode/contracts";
import {
  WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
  workspaceHookTrustRecordSchema,
  workspaceHookTrustStoreFileSchema,
} from "@zcode/contracts";
import {
  type WorkspaceHookTrustStorePathOptions,
  type FileWorkspaceHookTrustStoreOptions,
  type WorkspaceHookTrustStoreLoadResult,
  type WorkspaceHookTrustStoreRevokeOptions,
  type WorkspaceHookTrustStoreCompactOptions,
  type LockOwnerMetadata,
} from "./workspace-hook-trust-types.js";
import {
  resolveWorkspaceHookTrustStorePath,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STALE_LOCK_MS,
  DEFAULT_RENAME_RETRY_DELAYS_MS,
  probeProcessStartTimeDefault,
  defaultWriteLockOwnerMetadata,
  trustKey,
  recordTimestamp,
  currentProcessStartTimeMs,
  isNodeError,
  delay,
  LOCK_RETRY_MS,
  LOCK_START_TIME_TOLERANCE_MS,
  renameWithRetry,
} from "./workspace-hook-trust-files.js";

export async function createDefaultFileWorkspaceHookTrustStore(
  options: WorkspaceHookTrustStorePathOptions &
    Omit<FileWorkspaceHookTrustStoreOptions, "filePath"> = {},
): Promise<FileWorkspaceHookTrustStore> {
  return createFileWorkspaceHookTrustStore({
    ...options,
    filePath: await resolveWorkspaceHookTrustStorePath(options),
  });
}

export function createFileWorkspaceHookTrustStore(
  options: FileWorkspaceHookTrustStoreOptions,
): FileWorkspaceHookTrustStore {
  return new FileWorkspaceHookTrustStore(options);
}

export class FileWorkspaceHookTrustStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly now: () => number;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly beforeRename?: () => void | Promise<void>;
  private readonly renameFile: typeof rename;
  private readonly renameRetryDelaysMs: readonly number[];
  private readonly probeProcessStartTime: (pid: number) => Promise<number | null>;
  private readonly writeLockOwnerMetadata: (handle: FileHandle, content: string) => Promise<void>;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: FileWorkspaceHookTrustStoreOptions) {
    this.filePath = resolve(options.filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.now = options.now ?? Date.now;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.beforeRename = options.beforeRename;
    this.renameFile = options.renameFile ?? rename;
    this.renameRetryDelaysMs = options.renameRetryDelaysMs ?? DEFAULT_RENAME_RETRY_DELAYS_MS;
    this.probeProcessStartTime = options.probeProcessStartTime ?? probeProcessStartTimeDefault;
    this.writeLockOwnerMetadata = options.writeLockOwnerMetadata ?? defaultWriteLockOwnerMetadata;
  }

  load(): Promise<WorkspaceHookTrustStoreLoadResult> {
    return this.enqueue(async () => {
      await this.ensureSecurityDirectory();
      return this.withLock(() => this.readCurrent(true));
    });
  }

  grant(records: readonly WorkspaceHookTrustRecord[]): Promise<WorkspaceHookTrustStoreFile> {
    const validated = records.map((record) => workspaceHookTrustRecordSchema.parse(record));
    return this.mutate((current) => {
      const next = new Map(current.records.map((record) => [trustKey(record), record] as const));
      for (const record of validated) next.set(trustKey(record), record);
      return {
        schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
        records: [...next.values()],
      };
    });
  }

  revoke(options: WorkspaceHookTrustStoreRevokeOptions): Promise<WorkspaceHookTrustStoreFile> {
    if (options.hookDeclarationDigests?.length === 0) {
      // 空数组会生成空 Set，filter 因而保留全部记录并静默成功，调用方无法
      // 区分“撤销全部”的 undefined 与“没有目标”的无效请求。三态固定为：undefined
      // 撤销 workspace 全部、非空数组精确撤销、空数组在任何 IO 前拒绝。
      return Promise.reject(new Error("hookDeclarationDigests must be undefined or non-empty"));
    }
    const selected = options.hookDeclarationDigests
      ? new Set(options.hookDeclarationDigests)
      : undefined;
    return this.mutate((current) => ({
      schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
      records: current.records.filter(
        (record) =>
          record.workspaceIdentity !== options.workspaceIdentity ||
          (selected !== undefined && !selected.has(record.hookDeclarationDigest)),
      ),
    }));
  }

  touch(input: {
    workspaceIdentity: string;
    hookDeclarationDigests: readonly string[];
    usedAt?: string;
  }): Promise<WorkspaceHookTrustStoreFile> {
    const selected = new Set(input.hookDeclarationDigests);
    const usedAt = input.usedAt ?? new Date(this.now()).toISOString();
    return this.mutate((current) => ({
      schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
      records: current.records.map((record) =>
        record.workspaceIdentity === input.workspaceIdentity &&
        selected.has(record.hookDeclarationDigest)
          ? { ...record, lastUsedAt: usedAt }
          : record,
      ),
    }));
  }

  compact(options: WorkspaceHookTrustStoreCompactOptions): Promise<WorkspaceHookTrustStoreFile> {
    if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0) {
      throw new Error("maxAgeMs must be a nonnegative finite number");
    }
    if (!Number.isInteger(options.maxRecords) || options.maxRecords < 1) {
      throw new Error("maxRecords must be a positive integer");
    }
    const now = options.now ?? this.now();
    const current = new Set(
      options.current.map((entry) =>
        trustKey({
          workspaceIdentity: entry.workspaceIdentity,
          hookDeclarationDigest: entry.hookDeclarationDigest,
        }),
      ),
    );
    return this.mutate((store) => {
      const retained = store.records.filter((record) => {
        if (current.has(trustKey(record))) return true;
        const timestamp = Date.parse(record.lastUsedAt ?? record.grantedAt);
        return Number.isFinite(timestamp) && now - timestamp <= options.maxAgeMs;
      });
      const currentRecords = retained.filter((record) => current.has(trustKey(record)));
      const nonCurrent = retained
        .filter((record) => !current.has(trustKey(record)))
        .sort((left, right) => recordTimestamp(right) - recordTimestamp(left));
      const available = Math.max(0, options.maxRecords - currentRecords.length);
      return {
        schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
        records: [...currentRecords, ...nonCurrent.slice(0, available)],
      };
    });
  }

  private mutate(
    update: (current: WorkspaceHookTrustStoreFile) => WorkspaceHookTrustStoreFile,
  ): Promise<WorkspaceHookTrustStoreFile> {
    return this.enqueue(async () => {
      await this.ensureSecurityDirectory();
      return this.withLock(async () => {
        const loaded = await this.readCurrent(true);
        const current: WorkspaceHookTrustStoreFile = {
          schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
          records: loaded.status === "ok" ? loaded.records : [],
        };
        const next = workspaceHookTrustStoreFileSchema.parse(update(current));
        await this.atomicWrite(next);
        return next;
      });
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const { handle, token } = await this.acquireLock();
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      // 释放前必须验证所有权。本进程的锁可能已被 stale 回收并归属
      // 新持有者；无条件 unlink 会删掉新持有者的锁，让后续 writer 与之并发
      // 进入临界区，造成基于旧快照的 read-modify-write 覆盖已提交的 revoke/grant。
      await this.releaseLockIfOwned(token);
    }
  }

  private async acquireLock(): Promise<{ handle: FileHandle; token: string }> {
    const startedAt = Date.now();
    while (true) {
      let handle: FileHandle | undefined;
      try {
        handle = await open(this.lockPath, "wx", 0o600);
        // 锁内容写入 pid + 进程启动时间 + 不可预测 owner token。
        // startTime 是进程实例标识——裸 pid 会被系统复用，仅凭
        // process.kill(pid, 0) 判活会把「崩溃后 pid 被复用」的锁误判为
        // 活 owner 而永不回收，revoke/grant 全部卡死。回收侧用 probe 比对
        // 当前实例启动时间与锁内记录来区分原 owner 与复用者。
        const token = randomUUID();
        const owner = `${JSON.stringify({
          pid: process.pid,
          startTime: currentProcessStartTimeMs(),
          token,
        })}\n`;
        await this.writeLockOwnerMetadata(handle, owner);
        return { handle, token };
      } catch (error) {
        // open(wx) 成功但 metadata 写失败（磁盘满等）时，必须关闭句柄
        // 并删除自己刚创建的锁——残留空锁会被后续 writer 当作无主锁回收，
        // 破坏互斥；这里只可能删掉自己 wx 独占创建的文件，无越权风险。
        if (handle) {
          await handle.close().catch(() => undefined);
          await unlink(this.lockPath).catch(() => undefined);
        }
        if (!isNodeError(error, "EEXIST")) throw error;
        await this.removeStaleLock();
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new Error(`Timed out acquiring Workspace Hook Trust store lock: ${this.lockPath}`);
        }
        await delay(LOCK_RETRY_MS);
      }
    }
  }

  /** 仅当锁仍属于 token 对应持有者时才删除；无主（缺失/他人）一律不动。 */
  private async releaseLockIfOwned(token: string): Promise<void> {
    const owner = await this.readLockOwner();
    if (!owner || owner.token !== token) return;
    await unlink(this.lockPath).catch(() => undefined);
  }

  private async readLockOwner(): Promise<LockOwnerMetadata | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.lockPath, "utf8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { pid?: unknown }).pid === "number" &&
        typeof (parsed as { token?: unknown }).token === "string"
      ) {
        return {
          pid: (parsed as { pid: number }).pid,
          token: (parsed as { token: string }).token,
          startTime:
            typeof (parsed as { startTime?: unknown }).startTime === "number"
              ? (parsed as { startTime: number }).startTime
              : undefined,
        };
      }
      return null;
    } catch {
      // 旧版本空锁/损坏锁 → 无主。
      return null;
    }
  }

  /** pid 存活检测：signal 0 探测。EPERM（Windows 无权限）视为存活，ESRCH/EINVAL 视为死亡。 */
  private isProcessAlive(pid: number): boolean {
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return isNodeError(error, "EPERM");
    }
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const lockStats = await stat(this.lockPath);
      if (Date.now() - lockStats.mtimeMs <= this.staleLockMs) return;
      // 超龄但持有进程仍存活（休眠/调试暂停/杀毒拖慢 IO）→ 不回收。
      // mtime 无法区分"持有者死亡"与"持有者暂停或慢"；pid 存活检测可以。
      // 无法解析的锁（旧版空文件）无 pid 可查 → 按死亡回收。
      const owner = await this.readLockOwner();
      if (!owner) {
        await rm(this.lockPath, { force: true });
        return;
      }
      if (owner.pid === process.pid) return;
      if (!this.isProcessAlive(owner.pid)) {
        await rm(this.lockPath, { force: true });
        return;
      }
      // pid 存活 ≠ 原 owner 存活。pid 会被系统复用——原 owner 崩溃后
      // 其 pid 若被分配给无关长命进程，纯 kill(0) 判活会让锁永不回收，
      // revoke/grant 全部卡死。用进程实例启动时间核验：锁内记录的 startTime
      // 与该 pid 当前实例的实际启动时间一致 → 原 owner 确实活着（不回收）；
      // 不一致 → 原 owner 已死、pid 已易主（安全回收）。probe 不可用（平台
      // 不支持/查询失败）或锁记录无 startTime（上一版格式混存窗口）→ 保守
      // 视为原 owner 存活，不回收。
      const currentStart = await this.probeProcessStartTime(owner.pid);
      if (currentStart === null || owner.startTime === undefined) return;
      if (Math.abs(currentStart - owner.startTime) > LOCK_START_TIME_TOLERANCE_MS) {
        await rm(this.lockPath, { force: true });
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }

  private async ensureSecurityDirectory(): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  private async readCurrent(recoverCorrupt: boolean): Promise<WorkspaceHookTrustStoreLoadResult> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { status: "missing", records: [] };
      throw error;
    }

    try {
      const parsed = workspaceHookTrustStoreFileSchema.parse(JSON.parse(content) as unknown);
      // chmod 是权限加固副作用，不是 load 的核心职责。只读目录/异常所有权下
      // chmod 会抛 EPERM/EROFS，若任其冒泡，整个 load 都会失败——比一次加固失败
      // 应有的后果重得多。加固失败只降级为忽略：读出来的记录仍然有效，
      // 后续 mutate 的 atomicWrite 会再次尝试。
      await chmod(this.filePath, 0o600).catch(() => undefined);
      return { status: "ok", records: parsed.records };
    } catch (error) {
      if (!recoverCorrupt) throw error;
      const recoveredCorruptPath = `${this.filePath}.corrupt-${this.now()}`;
      // 损坏文件改名失败（只读目录等）若让错误冒泡，会绕过"返回 corrupt 状态"
      // 的设计路径——调用方看到的是意外异常而非 fail-closed 的 corrupt 状态。
      // 改名失败仍按 corrupt 返回：corrupt 语义即全部 Hook 不受信（fail-closed），
      // 原文件残留在原地不会让任何记录被当作可信。
      try {
        await rename(this.filePath, recoveredCorruptPath);
        await chmod(recoveredCorruptPath, 0o600).catch(() => undefined);
      } catch {
        // 改名失败：仍返回 corrupt 状态，原损坏文件留在原地（下次 load 仍判 corrupt）。
      }
      return { status: "corrupt", records: [], recoveredCorruptPath };
    }
  }

  private async atomicWrite(store: WorkspaceHookTrustStoreFile): Promise<void> {
    const directory = dirname(this.filePath);
    const tempPath = join(
      directory,
      `.${basename(this.filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.beforeRename?.();
      await renameWithRetry(this.renameFile, tempPath, this.filePath, this.renameRetryDelaysMs);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export { type WorkspaceHookTrustStoreLoadResult } from "./workspace-hook-trust-types.js";
export { type FileWorkspaceHookTrustStoreOptions } from "./workspace-hook-trust-types.js";
export { type WorkspaceHookTrustStoreCompactOptions } from "./workspace-hook-trust-types.js";
export { type WorkspaceHookTrustStoreRevokeOptions } from "./workspace-hook-trust-types.js";
export { type WorkspaceHookTrustStorePathOptions } from "./workspace-hook-trust-types.js";
export { resolveWorkspaceHookTrustStorePath } from "./workspace-hook-trust-files.js";
