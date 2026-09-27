import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const LIST_WORKSPACE_TASKS_TOOL_NAME = "ListWorkspaceTasks";
export const SEND_TASK_MESSAGE_TOOL_NAME = "SendTaskMessage";

export const ListWorkspaceTasksInputSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(4096).optional(),
    search: z.string().max(200).optional(),
    archived: z.boolean().optional(),
  })
  .strict();
export const ListWorkspaceTasksInputJsonSchema = toToolJsonSchema(ListWorkspaceTasksInputSchema);

export const SendTaskMessageInputSchema = z
  .object({
    toTaskId: z
      .string()
      .min(1)
      .max(200)
      .describe("Target top-level task ID from ListWorkspaceTasks"),
    message: z
      .string()
      .min(1)
      .max(20_000)
      .refine((value) => value.trim().length > 0, "Message must not be blank")
      .describe("Plain text prompt to send"),
    retryCommandId: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe(
        "Original command ID after querying an uncertain result; retry never creates a second input",
      ),
  })
  .strict();
export const SendTaskMessageInputJsonSchema = toToolJsonSchema(SendTaskMessageInputSchema);
