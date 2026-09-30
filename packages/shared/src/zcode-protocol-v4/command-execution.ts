// Modified by ZCode Feiyu contributors (2026).
import { z } from "zod";

// 命令执行观察。
// 从 `command.ts` 拆出：该文件在 CONT 续做后有效行数达到 402（上限 400），
// 而本组合计 7 个状态的枚举无法在不改变语义的前提下压缩。
// 保持定义位置单一：这里只放 schema，`command.ts` 重新导出以维持既有公开入口。
/** ACK 只说明命令被接受；本 schema 回答「该命令当前是否仍在执行」。 */
export const commandExecutionSchema = z
  .object({
    state: z.enum([
      "queued",
      "running",
      "succeeded",
      "interrupted",
      "failed",
      "cancelled",
      "unknown",
    ]),
    targetTurnId: z.string().optional(),
    reasonCode: z.string().optional(),
  })
  .strict();
export type CommandExecution = z.infer<typeof commandExecutionSchema>;
