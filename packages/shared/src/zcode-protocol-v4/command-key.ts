// Modified by ZCode Feiyu.
import { z } from "zod";

// ── commands/query ──
export const commandKeySchema = z
  .object({
    // null 只属于全局/createSession 幂等桶；session 命令必须携带 sessionId。
    sessionId: z.string().nullable(),
    commandId: z.string().min(1),
  })
  .strict();

export type CommandKey = z.infer<typeof commandKeySchema>;
