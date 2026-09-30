// Modified by ZCode Feiyu contributors (2026).
import type { ModelToolContract } from "@zcode/contracts";
import type { OrchestrationMode } from "@zcode/shared/zcode-protocol-v4";
import { isSubagentDispatchToolName } from "../tool/compat.js";

const COORDINATOR_PARENT_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "Agent",
  "SendMessage",
  "TaskOutput",
  "TaskStop",
  "TodoRead",
  "TodoWrite",
  "AskUserQuestion",
]);

export function selectOrchestrationParentTools(
  tools: readonly ModelToolContract[],
  mode: OrchestrationMode,
  teamMember = false,
): ModelToolContract[] {
  const selected = tools.filter((tool) =>
    isOrchestrationParentToolAllowed(tool.name, mode, teamMember),
  );
  if (mode === "coordinator" && !selected.some((tool) => isSubagentDispatchToolName(tool.name))) {
    throw new Error("Coordinator mode requires an available subagent dispatch tool");
  }
  return selected;
}

export function isOrchestrationParentToolAllowed(
  toolName: string,
  mode: OrchestrationMode,
  teamMember = false,
): boolean {
  if (toolName === "TeamTask") return mode === "swarm" || teamMember;
  return (
    mode !== "coordinator" ||
    COORDINATOR_PARENT_TOOLS.has(toolName) ||
    isSubagentDispatchToolName(toolName)
  );
}

export function orchestrationReminderBody(mode: OrchestrationMode): string | null {
  if (mode === "standard") return null;
  if (mode === "coordinator") {
    return "Coordinator mode is active for this task. Break the request into bounded pieces, delegate execution through the Agent tool, observe each result, and integrate the final answer. Your direct tools are limited to reading, task progress, and agent control. Child agents inherit the task's model and permission policy. Report partial failures clearly.";
  }
  return "Swarm mode is active for this task. Launch up to eight named local agents using Agent.name, maintain the shared task board with TeamTask, and message members by name or agent ID with SendMessage. Members can read and claim board tasks and message other members. Observe completion and integrate the result. Agent messages remain inside this task and do not impersonate another top-level task. Respect the current model, permissions, and resource limits.";
}
