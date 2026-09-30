// Modified by ZCode Feiyu contributors (2026).
import {
  TEAM_TASK_TOOL_NAME,
  TeamTaskInputSchema,
  TeamTaskInputJsonSchema,
  TeamBoardStateSchema,
  TeamBoardStateJsonSchema,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const handler: ToolHandler = async (input, context) => {
  if (!context.teamBoardPort || !context.teamActorId) {
    throw new Error("Team task board is unavailable for this agent");
  }
  return context.teamBoardPort.execute(TeamTaskInputSchema.parse(input), context.teamActorId);
};

export const teamTaskToolEntry: ToolEntry = {
  capability: "Read and update the current task's shared team board",
  metadata: {
    name: TEAM_TASK_TOOL_NAME,
    description:
      "Manage the shared task board inside this top-level task. Actions: list, create, claim, assign, complete, cancel. Task IDs are returned by the board. Only the coordinator can assign or cancel; a member can complete their own task.",
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30_000,
    maxOutputBytes: 32_768,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler,
  inputSchema: TeamTaskInputJsonSchema,
  outputSchema: TeamBoardStateJsonSchema,
  runtimeInputSchema: TeamTaskInputSchema,
  runtimeOutputSchema: TeamBoardStateSchema,
  permission: {
    permission: "todo.write",
    reason: "TeamTask updates only the task-local shared board",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 32_768,
    maxModelBytes: 32_768,
    strategy: "truncate",
    preview: { maxBytes: 32_768, direction: "head" },
  },
  timeout: { defaultMs: 30_000, maxMs: 30_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Team task update was cancelled before the result returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
