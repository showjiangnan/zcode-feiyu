// Modified by ZCode Feiyu contributors (2026).
import { z } from "zod";
import { runtimeCapabilitySchema } from "./continuity-policy.js";
import { proactiveCausalContextSchema } from "./zcode-protocol-v4/orchestration.js";
import { commandAckSchema, commandExecutionSchema } from "./zcode-protocol-v4/command.js";
import { conversationRowTargetSchema } from "./zcode-protocol-v4/core.js";
import { v4ConversationRowsRangeResultSchema } from "./zcode-protocol-v4/transport.js";

export const TASK_APP_SERVER_VERSION = 1;
export const TASK_APP_SERVER_LIMITS = {
  pageSize: 50,
  maxPageSize: 100,
  maxWaitMs: 25_000,
  maxPendingRequests: 128,
  maxMessageChars: 20_000,
} as const;
const id = z.string().min(1).max(512);
const cursor = z.string().min(1).max(4096);
const target = { taskId: id };
const page = { limit: z.number().int().min(1).max(100).optional() };
export const taskAppOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("capabilities") }).strict(),
  z
    .object({
      type: z.literal("list"),
      ...page,
      cursor: cursor.optional(),
      search: z.string().max(200).optional(),
      archived: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("create"), title: z.string().trim().min(1).max(300).optional() })
    .strict(),
  z
    .object({
      type: z.literal("read"),
      ...target,
      ...page,
      beforeRowId: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("send"),
      ...target,
      message: z
        .string()
        .min(1)
        .max(20_000)
        .refine((v) => v.trim().length > 0),
      delivery: z.enum(["auto", "queue"]).optional(),
      retryCommandId: id.optional(),
      /** 执行端注入；工具输入不提供此字段。 */
      causalContext: proactiveCausalContextSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("query"), ...target, commandId: id }).strict(),
  z
    .object({
      type: z.literal("wait"),
      ...target,
      commandId: id.optional(),
      afterCursor: cursor.optional(),
      timeoutMs: z.number().int().min(0).max(25_000).optional(),
    })
    .strict(),
  z.object({ type: z.literal("cancelWait"), ...target, waitRequestId: id }).strict(),
  z.object({ type: z.literal("resume"), ...target }).strict(),
  z
    .object({ type: z.literal("rename"), ...target, title: z.string().trim().min(1).max(300) })
    .strict(),
  z.object({ type: z.literal("archive"), ...target }).strict(),
  z.object({ type: z.literal("unarchive"), ...target }).strict(),
  z.object({ type: z.literal("close"), ...target }).strict(),
  z.object({ type: z.literal("compact"), ...target }).strict(),
  z.object({ type: z.literal("stop"), ...target, expectedForegroundExecutionId: id }).strict(),
  z.object({ type: z.literal("cancelInput"), ...target, commandId: id }).strict(),
  z
    .object({
      type: z.literal("fork"),
      ...target,
      target: conversationRowTargetSchema,
      baseRevision: z.number().int().nonnegative(),
      baseLogEpoch: id,
    })
    .strict(),
]);
export type TaskAppOperation = z.infer<typeof taskAppOperationSchema>;

export const taskAppRequestSchema = z
  .object({
    sourceSessionId: id,
    requestId: id,
    operation: taskAppOperationSchema,
  })
  .strict();
export type TaskAppRequest = z.infer<typeof taskAppRequestSchema>;
export const taskAppErrorSchema = z
  .object({
    code: z.enum([
      "invalid_request",
      "forbidden",
      "not_found",
      "unavailable",
      "overloaded",
      "stale",
      "rejected",
      "result_unknown",
      "cancelled",
    ]),
    message: z.string(),
    retryable: z.boolean(),
  })
  .strict();
export type TaskAppError = z.infer<typeof taskAppErrorSchema>;
const taskSummarySchema = z
  .object({ taskId: id, title: z.string(), status: z.string(), archived: z.boolean() })
  .strict();
const readSchema = z
  .object({
    task: taskSummarySchema,
    cursor,
    history: v4ConversationRowsRangeResultSchema,
  })
  .strict();
export type TaskAppRead = z.infer<typeof readSchema>;
export const taskAppResultSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("capabilities"),
      version: z.literal(1),
      scope: z.literal("desktop-local-workspace"),
      operations: z.array(z.string()),
      capabilities: z.record(z.string(), runtimeCapabilitySchema).optional(),
      maxPageSize: z.number(),
      maxWaitMs: z.number(),
      maxPendingRequests: z.number(),
      maxMessageChars: z.number(),
      permissions: z
        .object({ approveOtherTask: z.literal(false), changeOtherTaskModel: z.literal(false) })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("list"),
      tasks: z.array(taskSummarySchema),
      nextCursor: cursor.nullable(),
    })
    .strict(),
  z.object({ type: z.literal("read"), ...readSchema.shape }).strict(),
  z
    .object({
      type: z.literal("query"),
      commandId: id,
      ack: commandAckSchema.nullable(),
      execution: commandExecutionSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("wait"),
      ...readSchema.shape,
      reason: z.enum(["changed", "terminal", "timeout", "needs_input"]),
      ack: commandAckSchema.nullable().optional(),
      execution: commandExecutionSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("command"),
      taskId: id,
      commandId: id,
      ack: commandAckSchema.optional(),
    })
    .strict(),
]);
export type TaskAppResult = z.infer<typeof taskAppResultSchema>;
export const taskAppResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), requestId: id, result: taskAppResultSchema }).strict(),
  z.object({ ok: z.literal(false), requestId: id, error: taskAppErrorSchema }).strict(),
]);
export type TaskAppResponse = z.infer<typeof taskAppResponseSchema>;
