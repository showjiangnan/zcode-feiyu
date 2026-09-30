// Modified by ZCode Feiyu contributors (2026).
import type { DatabaseSync } from "node:sqlite";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  type SessionId,
  type SessionStorePort,
} from "@zcode/contracts";
import { saveSessionEntry } from "./session-entries.js";
import { createSession, getSession } from "./sessions.js";

type CreateByOrigin = NonNullable<SessionStorePort["getOrCreateSessionByOrigin"]>;
const ORIGIN_ENTRY_TYPE = "runtime/session_create_origin";

/** 创建来源只存在 session 库；不能把 task index 的 automation 分组当作 run 身份。 */
export function getOrCreateSessionByOrigin(
  db: DatabaseSync,
  input: Parameters<CreateByOrigin>[0],
  origin: Parameters<CreateByOrigin>[1],
): Awaited<ReturnType<CreateByOrigin>> {
  const workspaceKey = input.workspaceID?.trim() || input.directory;
  if (!origin.commandId.trim() || !origin.requestFingerprint || !workspaceKey) {
    throw new Error("Session create origin is invalid");
  }
  // JSON 元组避免路径/command 含分隔符时碰撞；entry 主键在全库唯一。
  const entryId = `${ORIGIN_ENTRY_TYPE}:${JSON.stringify([workspaceKey, origin.commandId])}`;
  db.exec("begin immediate");
  try {
    const existing = db
      .prepare("select session_id, type, data from session_entry where id = ?")
      .get(entryId) as { session_id: string; type: string; data: string } | undefined;
    if (existing) {
      const data = JSON.parse(existing.data) as Record<string, unknown>;
      if (
        existing.type !== ORIGIN_ENTRY_TYPE ||
        data.sourceCommandId !== origin.commandId ||
        data.workspaceKey !== workspaceKey ||
        data.requestFingerprint !== origin.requestFingerprint
      ) {
        throw new Error("Session create origin conflicts with the original request");
      }
      const session = getSession(db, existing.session_id as SessionId);
      if (!session || (session.workspaceID?.trim() || session.directory) !== workspaceKey) {
        throw new Error("Session create origin refers to a missing or mismatched session");
      }
      if (session.time.archived !== undefined) throw new Error("Session create origin is archived");
      db.exec("commit");
      return session;
    }
    if (getSession(db, input.id)) throw new Error("Session create candidate ID already exists");
    const session = createSession(db, input);
    // 原因：先写 session 再跨事务补来源，强杀会留下永远查不到的空任务。
    // 来源与首次 CLI 身份必须同事务提交，竞争失败者绝不先插入自己的 session。
    saveSessionEntry(db, {
      id: entryId,
      sessionID: session.id,
      type: ORIGIN_ENTRY_TYPE,
      touchSession: false,
      time: session.time,
      data: {
        sourceCommandId: origin.commandId,
        workspaceKey,
        requestFingerprint: origin.requestFingerprint,
        ...(origin.commandFingerprint ? { commandFingerprint: origin.commandFingerprint } : {}),
      },
    });
    if (origin.modelSelection)
      saveSessionEntry(db, {
        id: `${session.id}:runtime-model-selection`,
        sessionID: session.id,
        type: SESSION_ENTRY_MODEL_SELECTION,
        touchSession: false,
        time: session.time,
        data: origin.modelSelection,
      });
    db.exec("commit");
    return session;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

/** 全局 create 查询只认显式 V4 来源；跨工作区复用 ID 由调用方拒绝歧义。 */
export function readSessionCreateOrigins(
  db: DatabaseSync,
  commandId: string,
): Array<{ sessionId: SessionId; workspaceKey: string; commandFingerprint: string }> {
  const rows = db
    .prepare(
      "select session_id,data from session_entry where type=? and json_extract(data,'$.sourceCommandId')=? and json_type(data,'$.commandFingerprint')='text'",
    )
    .all(ORIGIN_ENTRY_TYPE, commandId) as Array<{ session_id: string; data: string }>;
  return rows.map((row) => {
    const data = JSON.parse(row.data);
    return {
      sessionId: row.session_id as SessionId,
      workspaceKey: data.workspaceKey,
      commandFingerprint: data.commandFingerprint,
    };
  });
}
