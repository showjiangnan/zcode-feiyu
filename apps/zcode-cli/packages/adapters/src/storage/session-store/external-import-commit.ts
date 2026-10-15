// Modified by ZCode Feiyu.
import type { DatabaseSync } from "node:sqlite";
import type { ExternalImportCommitBundle, SessionInfo } from "@zcode/contracts";
import * as sessions from "./repositories/sessions.js";
import * as messages from "./repositories/messages.js";
import * as entries from "./repositories/session-entries.js";

export function commitExternalHistory(
  db: DatabaseSync,
  bundle: ExternalImportCommitBundle,
): SessionInfo {
  const { session, provenance } = bundle;
  if (
    provenance.type !== "external/import" ||
    provenance.sessionID !== session.id ||
    bundle.messages.some(
      (message) =>
        message.info.sessionID !== session.id ||
        message.parts.some(
          (part) => part.sessionID !== session.id || part.messageID !== message.info.id,
        ),
    )
  )
    throw new Error("External import identity mismatch");
  // 事务内没有 await；同一连接的其它请求不能插入半份历史。
  db.exec("begin immediate");
  try {
    const existing = sessions.getSession(db, session.id);
    if (existing) {
      const proof = entries
        .sessionEntries(db, { sessionID: session.id, type: provenance.type })
        .find((item) => item.id === provenance.id);
      if (
        existing.directory !== session.directory ||
        existing.workspaceID !== session.workspaceID ||
        !proof ||
        JSON.stringify(proof.data) !== JSON.stringify(provenance.data)
      )
        throw new Error("External import version conflict");
      db.exec("commit");
      return existing;
    }
    const persisted = sessions.createSession(db, session);
    for (const message of bundle.messages) {
      messages.saveMessageSync(db, message.info);
      for (const part of message.parts) messages.savePartSync(db, part);
    }
    entries.saveSessionEntry(db, provenance);
    // 导入消息写入会触发常规 touch；首次事务提交恢复来源时间，重复导入不改本地时间。
    db.prepare("update session set time_created = ?, time_updated = ? where id = ?").run(
      session.time?.created ?? persisted.time.created,
      session.time?.updated ?? persisted.time.updated,
      session.id,
    );
    db.exec("commit");
    return sessions.getSession(db, session.id)!;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
