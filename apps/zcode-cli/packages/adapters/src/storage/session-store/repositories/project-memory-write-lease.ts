// Modified by ZCode Feiyu contributors (2026).
import type { DatabaseSync } from "node:sqlite";

export function claimProjectMemoryWrite(
  db: DatabaseSync,
  input: {
    workspaceKey: string;
    ownerId: string;
    now: number;
    leaseDurationMs: number;
  },
  transactionOwned = false,
): { status: "claimed"; epoch: number } | { status: "leased" } {
  if (!transactionOwned) db.exec("begin immediate");
  try {
    db.prepare(`
      insert or ignore into project_memory_write_lease (workspace_key) values (?)
    `).run(input.workspaceKey);
    const row = db
      .prepare(`
      select owner_id, epoch, lease_until from project_memory_write_lease where workspace_key = ?
    `)
      .get(input.workspaceKey) as {
      owner_id: string | null;
      epoch: number;
      lease_until: number | null;
    };
    if (row.owner_id && row.lease_until !== null && row.lease_until > input.now) {
      if (!transactionOwned) db.exec("commit");
      return { status: "leased" };
    }
    const epoch = row.epoch + 1;
    db.prepare(`
      update project_memory_write_lease set owner_id = ?, epoch = ?, lease_until = ?
      where workspace_key = ?
    `).run(input.ownerId, epoch, input.now + input.leaseDurationMs, input.workspaceKey);
    if (!transactionOwned) db.exec("commit");
    return { status: "claimed", epoch };
  } catch (error) {
    if (!transactionOwned) db.exec("rollback");
    throw error;
  }
}

export function renewProjectMemoryWrite(
  db: DatabaseSync,
  input: {
    workspaceKey: string;
    ownerId: string;
    epoch: number;
    now: number;
    leaseDurationMs: number;
  },
): boolean {
  return (
    db
      .prepare(`
    update project_memory_write_lease set lease_until = ?
    where workspace_key = ? and owner_id = ? and epoch = ? and lease_until > ?
  `)
      .run(
        input.now + input.leaseDurationMs,
        input.workspaceKey,
        input.ownerId,
        input.epoch,
        input.now,
      ).changes === 1
  );
}

export function releaseProjectMemoryWrite(
  db: DatabaseSync,
  input: {
    workspaceKey: string;
    ownerId: string;
    epoch: number;
  },
): boolean {
  return (
    db
      .prepare(`
    update project_memory_write_lease set owner_id = null, lease_until = null
    where workspace_key = ? and owner_id = ? and epoch = ?
  `)
      .run(input.workspaceKey, input.ownerId, input.epoch).changes === 1
  );
}
