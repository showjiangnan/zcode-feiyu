// Modified by ZCode Feiyu contributors (2026).
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

/** 独立库避免记忆文件 I/O 临界区阻塞会话消息库；SQLite 进程退出自动释放锁。 */
export async function withMemoryCoordination<T>(
  sessionPath: string,
  operation: (db: DatabaseSync) => Promise<T> | T,
): Promise<T> {
  const path = `${sessionPath}.memory-coordination`;
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  let locked = false;
  try {
    db.exec("pragma busy_timeout=0");
    const deadline = Date.now() + 30_000;
    while (!locked) {
      try {
        db.exec("begin exclusive");
        locked = true;
      } catch (error) {
        const code =
          error && typeof error === "object" && "errcode" in error ? error.errcode : undefined;
        if ((code !== 5 && code !== 6) || Date.now() >= deadline) throw error;
        await delay(20);
      }
    }
    db.exec(`create table if not exists project_memory_write_lease (
      workspace_key text primary key, owner_id text, epoch integer not null default 0, lease_until integer)`);
    const result = await operation(db);
    db.exec("commit");
    locked = false;
    return result;
  } finally {
    if (locked) db.exec("rollback");
    db.close();
  }
}

export function assertMemoryFence(
  db: DatabaseSync,
  input: { workspaceKey: string; ownerId: string; epoch: number },
): void {
  const row = db
    .prepare(`select 1 from project_memory_write_lease where workspace_key = ?
    and owner_id = ? and epoch = ? and lease_until > ?`)
    .get(input.workspaceKey, input.ownerId, input.epoch, Date.now());
  if (!row) throw new Error("Project memory write lease was lost before commit");
}
