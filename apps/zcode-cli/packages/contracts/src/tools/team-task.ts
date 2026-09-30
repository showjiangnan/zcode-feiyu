// Modified by ZCode Feiyu contributors (2026).
import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const TEAM_TASK_TOOL_NAME = "TeamTask";

const taskDescription = z.string().trim().min(1).max(2_000);
const taskId = z.string().min(1);
const memberName = z.string().min(1).max(32);
const taskResult = z.string().max(2_000);

export const TeamTaskInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("create"), description: taskDescription }).strict(),
  z.object({ action: z.literal("claim"), taskId }).strict(),
  z
    .object({
      action: z.literal("assign"),
      taskId,
      member: memberName,
    })
    .strict(),
  z
    .object({
      action: z.literal("complete"),
      taskId,
      result: taskResult.optional(),
    })
    .strict(),
  z.object({ action: z.literal("cancel"), taskId }).strict(),
]);
export type TeamTaskInput = z.infer<typeof TeamTaskInputSchema>;
// 提供商拒绝顶层联合（缺少 object 类型），即使每个分支都是对象也会使整个回合返回 400。
// 模型面使用普通对象与共享字段约束；执行面仍由上面的判别联合严格检查各动作必填/禁用字段。
export const TeamTaskInputJsonSchema = toToolJsonSchema(
  z
    .object({
      action: z.enum(["list", "create", "claim", "assign", "complete", "cancel"]),
      description: taskDescription
        .describe("Required only for create; omit for other actions")
        .optional(),
      taskId: taskId
        .describe("Required for claim, assign, complete and cancel; omit for list/create")
        .optional(),
      member: memberName.describe("Required only for assign; omit for other actions").optional(),
      result: taskResult.describe("Optional only for complete; omit for other actions").optional(),
    })
    .strict(),
);

// CLI tools use the contracts package's Zod runtime; V4 wire validation has a
// structurally equivalent schema in the shared protocol package.
export const TeamBoardTaskSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1).max(2_000),
    assigneeId: z.string().optional(),
    assigneeName: z.string().max(32).optional(),
    status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    result: z.string().max(2_000).optional(),
  })
  .strict();
export type TeamBoardTask = z.infer<typeof TeamBoardTaskSchema>;

export const TeamBoardStateSchema = z
  .object({
    branchGeneration: z.number().int().nonnegative().default(0),
    revision: z.number().int().nonnegative(),
    tasks: z.array(TeamBoardTaskSchema).max(64),
  })
  .strict();
export type TeamBoardState = z.infer<typeof TeamBoardStateSchema>;
export const TeamBoardStateJsonSchema = toToolJsonSchema(TeamBoardStateSchema);

export interface TeamBoardPort {
  execute(input: TeamTaskInput, actorId: string): Promise<TeamBoardState>;
}
