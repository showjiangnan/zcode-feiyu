// Modified by ZCode Feiyu contributors (2026).
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SessionStorePort } from "@zcode/contracts";
import { imageGenerationJobSchema } from "@zcode/shared";
import { saveSessionEntry } from "./session-entries.js";
/** 现有 session_entry 保存付费事实，事务把许可与作业意图绑定；换工具 ID 不能再次付费。 */
export function claimImageGenerationSubmission(
  db: DatabaseSync,
  input: Parameters<NonNullable<SessionStorePort["claimImageGenerationSubmission"]>>[0],
): boolean {
  if (!input.inputId.trim()) throw new Error("Image generation requires an admitted input ID");
  const job = imageGenerationJobSchema.parse(input.job);
  if (job.sessionId !== input.sessionId || job.state !== "submitting" || job.ticket)
    throw new Error("Invalid initial image generation intent");
  const id = `image-payment:${createHash("sha256")
    .update(JSON.stringify([input.sessionId, input.inputId]))
    .digest("hex")}`;
  db.exec("begin immediate");
  try {
    if (db.prepare("select 1 from session_entry where id=?").get(id)) {
      db.exec("commit");
      return false;
    }
    saveSessionEntry(db, {
      id,
      sessionID: input.sessionId,
      type: "image_generation/payment",
      touchSession: false,
      time: { created: job.createdAt, updated: job.createdAt },
      data: { inputId: input.inputId, generationId: job.generationId },
    });
    saveSessionEntry(db, {
      id: job.generationId,
      sessionID: input.sessionId,
      type: "image_generation/job",
      touchSession: false,
      time: { created: job.createdAt, updated: job.updatedAt },
      data: job,
    });
    db.exec("commit");
    return true;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
