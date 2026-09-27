import { taskAppOperationSchema, taskAppResponseSchema } from "@zcode/shared";
import { z } from "zod";
import type { ToolEntry } from "../types.js";
import { assertNotOffPeakTurn } from "./off-peak.js";

const READ_OPERATIONS = new Set(["capabilities", "list", "read", "query", "wait", "cancelWait"]);
// Provider 的工具根 schema 必须是 object；判别联合放在 operation 属性内。
const inputSchema = z.object({ operation: taskAppOperationSchema }).strict();

function taskServiceTool(name: string, readOnly: boolean): ToolEntry {
  const description = readOnly
    ? "Inspect local workspace tasks through the app service: capabilities, paginated list, read history/state, query an earlier command, or wait for a task/command. Use the returned cursor for subsequent waits. Waiting never stops the target."
    : "Manage top-level tasks in the same local workspace: create, send (automatic guide when busy), resume, fork at a stable row, rename, archive/unarchive, compact, close, stop an observed execution, or cancel your queued input. Query an uncertain command before retrying with its original ID. Never approve another task's tools or change its model/permissions.";
  return {
    capability: description,
    metadata: {
      name,
      description,
      readOnly,
      destructive: false,
      concurrentSafe: true,
      timeoutMs: 45_000,
      maxOutputBytes: 512_000,
      sideEffectScope: "session",
      riskLevel: "low",
      needsApproval: false,
    },
    handler: async (raw, context) => {
      const { operation } = inputSchema.parse(raw);
      if (readOnly !== READ_OPERATIONS.has(operation.type))
        throw new Error("Use the read or manage task tool matching this operation.");
      if (!readOnly) assertNotOffPeakTurn(context, name);
      if (!context.taskMessagePort?.request || !context.sessionId)
        throw new Error("Task app service is unavailable.");
      return context.taskMessagePort.request(
        {
          sourceSessionId: context.sessionId,
          requestId: `task-app:${context.sessionId}:${context.toolCallId}`,
          operation,
        },
        context.abortSignal,
      );
    },
    inputSchema: z.toJSONSchema(inputSchema),
    outputSchema: z.toJSONSchema(taskAppResponseSchema, { unrepresentable: "any" }),
    runtimeInputSchema: inputSchema,
    runtimeOutputSchema: taskAppResponseSchema,
    permission: {
      permission: readOnly ? "task.read" : "task.control",
      reason: description,
      riskLevel: "low",
      sideEffectScope: "session",
      needsApproval: false,
      patternSources: ["toolName", "input"],
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: 64_000,
      maxModelBytes: 64_000,
      strategy: "artifact",
      preview: { maxBytes: 16_000, direction: "head" },
    },
    timeout: { defaultMs: 45_000, maxMs: 45_000, allowCallOverride: false },
    cancellation: {
      supported: true,
      cleanup: "none",
      userVisibleMessage: "Task service observation cancelled; the target task continues.",
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}

export const readWorkspaceTaskToolEntry = taskServiceTool("ReadWorkspaceTask", true);
export const manageWorkspaceTaskToolEntry = taskServiceTool("ManageWorkspaceTask", false);
