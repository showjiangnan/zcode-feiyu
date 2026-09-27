import { z } from "zod";
import {
  LIST_WORKSPACE_TASKS_TOOL_NAME,
  SEND_TASK_MESSAGE_TOOL_NAME,
  ListWorkspaceTasksInputJsonSchema,
  ListWorkspaceTasksInputSchema,
  SendTaskMessageInputJsonSchema,
  SendTaskMessageInputSchema,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { assertNotOffPeakTurn } from "./off-peak.js";

const targetSchema = z.object({ taskId: z.string(), title: z.string(), status: z.string() });
const listOutputSchema = z.object({
  tasks: z.array(targetSchema),
  nextCursor: z.string().nullable().optional(),
});
const sendOutputSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  delivery: z.enum(["startNow", "queue", "guide"]).optional(),
  fallbackReasonCode: z.string().optional(),
  targetTurnId: z.string().optional(),
  inputId: z.string().optional(),
  targetTaskId: z.string(),
  commandId: z.string().optional(),
  errorCode: z.string().optional(),
  retryable: z.boolean().optional(),
});

const listHandler: ToolHandler = async (input, context) => {
  if (!context.taskMessagePort || !context.sessionId)
    throw new Error("Task messaging is unavailable.");
  if (context.taskMessagePort.request) {
    const result = await context.taskMessagePort.request(
      {
        sourceSessionId: context.sessionId,
        requestId: `task-app:${context.sessionId}:${context.toolCallId}`,
        operation: { type: "list", ...ListWorkspaceTasksInputSchema.parse(input) },
      },
      context.abortSignal,
    );
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    if (result.result.type !== "list")
      throw new Error("Task service returned an unexpected result.");
    return { tasks: result.result.tasks, nextCursor: result.result.nextCursor };
  }
  return { tasks: await context.taskMessagePort.list({ sourceSessionId: context.sessionId }) };
};

const sendHandler: ToolHandler = async (input, context) => {
  const parsed = SendTaskMessageInputSchema.parse(input);
  assertNotOffPeakTurn(context, SEND_TASK_MESSAGE_TOOL_NAME);
  if (!context.taskMessagePort || !context.sessionId)
    throw new Error("Task messaging is unavailable.");
  if (context.taskMessagePort.request) {
    const commandId =
      parsed.retryCommandId ?? `task-message:${context.sessionId}:${context.toolCallId}`;
    const result = await context.taskMessagePort.request(
      {
        sourceSessionId: context.sessionId,
        requestId: `task-message:${context.sessionId}:${context.toolCallId}`,
        operation: {
          type: "send",
          taskId: parsed.toTaskId,
          message: parsed.message,
          ...(parsed.retryCommandId ? { retryCommandId: parsed.retryCommandId } : {}),
        },
      },
      context.abortSignal,
    );
    if (!result.ok)
      return {
        ok: false,
        targetTaskId: parsed.toTaskId,
        commandId,
        error: result.error.message,
        errorCode: result.error.code,
        retryable: result.error.retryable,
      };
    if (result.result.type !== "command")
      throw new Error("Task service returned an unexpected result.");
    const admission = result.result.ack?.result;
    return {
      ok: true,
      targetTaskId: parsed.toTaskId,
      commandId,
      ...(admission?.type === "inputAccepted"
        ? {
            delivery: admission.delivery,
            inputId: admission.inputId,
            ...(admission.targetTurnId ? { targetTurnId: admission.targetTurnId } : {}),
            ...(admission.fallbackReasonCode
              ? { fallbackReasonCode: admission.fallbackReasonCode }
              : {}),
          }
        : {}),
    };
  }
  if (parsed.retryCommandId) throw new Error("Retry requires the task app service.");
  return context.taskMessagePort.send({
    sourceSessionId: context.sessionId,
    targetTaskId: parsed.toTaskId,
    requestId: `task-message:${context.sessionId}:${context.toolCallId}`,
    message: parsed.message,
  });
};

export const listWorkspaceTasksToolEntry: ToolEntry = {
  capability: "List other top-level tasks in this local workspace",
  metadata: {
    name: LIST_WORKSPACE_TASKS_TOOL_NAME,
    description:
      "List other top-level ZCode tasks in this local desktop workspace. Follow nextCursor until null to read further pages. Use a taskId with SendTaskMessage or ReadWorkspaceTask.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 45_000,
    maxOutputBytes: 512_000,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: listHandler,
  inputSchema: ListWorkspaceTasksInputJsonSchema,
  outputSchema: z.toJSONSchema(listOutputSchema),
  runtimeInputSchema: ListWorkspaceTasksInputSchema,
  runtimeOutputSchema: listOutputSchema,
  permission: {
    permission: "task.list",
    reason: "ListWorkspaceTasks reads local task metadata",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 64_000,
    maxModelBytes: 64_000,
    strategy: "artifact",
    preview: { maxBytes: 16_384, direction: "head" },
  },
  timeout: { defaultMs: 45_000, maxMs: 45_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Task list request was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const sendTaskMessageToolEntry: ToolEntry = {
  capability: "Send a prompt to another top-level task in this local workspace",
  metadata: {
    name: SEND_TASK_MESSAGE_TOOL_NAME,
    description:
      "Send a plain text prompt to another top-level task. Running tasks receive guide input when steerable, otherwise queue with a reason. The receipt confirms admission, not completion. Use ReadWorkspaceTask query/wait with commandId to observe completion. Query result_unknown before retrying with retryCommandId.",
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 45_000,
    maxOutputBytes: 4096,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: sendHandler,
  inputSchema: SendTaskMessageInputJsonSchema,
  outputSchema: z.toJSONSchema(sendOutputSchema),
  runtimeInputSchema: SendTaskMessageInputSchema,
  runtimeOutputSchema: sendOutputSchema,
  permission: {
    permission: "task.message.send",
    reason: "SendTaskMessage submits a prompt to another local task",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 4096,
    maxModelBytes: 4096,
    strategy: "truncate",
    preview: { maxBytes: 4096, direction: "head" },
  },
  timeout: { defaultMs: 45_000, maxMs: 45_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Task message send was cancelled before delivery status returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
