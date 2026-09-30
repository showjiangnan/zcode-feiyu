// Modified by ZCode Feiyu contributors (2026).
import type { DatabaseSync } from "node:sqlite";
import type { MessageId, SessionId } from "@zcode/contracts";

export function readProjectMemoryExtractionCursor(
  db: DatabaseSync,
  sessionId: SessionId,
): MessageId | undefined {
  const row = db
    .prepare(`
    select boundary_message_id from project_memory_extraction_cursor where session_id = ?
  `)
    .get(sessionId) as { boundary_message_id: MessageId } | undefined;
  return row?.boundary_message_id;
}

export function advanceProjectMemoryExtractionCursor(
  db: DatabaseSync,
  input: {
    sessionId: SessionId;
    expectedCursor?: MessageId;
    nextCursor: MessageId;
    now: number;
  },
): boolean {
  db.exec("begin immediate");
  try {
    const current = readProjectMemoryExtractionCursor(db, input.sessionId);
    if (current === input.nextCursor) {
      db.exec("commit");
      return true;
    }
    if (current !== input.expectedCursor) {
      db.exec("commit");
      return false;
    }
    if (current === undefined) {
      db.prepare(`
        insert into project_memory_extraction_cursor (session_id, boundary_message_id, updated_at)
        values (?, ?, ?)
      `).run(input.sessionId, input.nextCursor, input.now);
    } else {
      db.prepare(`
        update project_memory_extraction_cursor
        set boundary_message_id = ?, updated_at = ? where session_id = ?
      `).run(input.nextCursor, input.now, input.sessionId);
    }
    db.exec("commit");
    return true;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
