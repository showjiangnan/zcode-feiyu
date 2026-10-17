// Modified by ZCode Feiyu.
import {
  legacySyntheticRuntimeMetadata,
  systemReminderRuntimeMetadata,
  todoReminderRuntimeMetadata,
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
  type RuntimeMessageMetadata,
} from "../../agent/message-history.js";
import type {
  CollaborationMode,
  OutputStylePromptConfig,
  SyntheticUserMessageSource,
  TodoItem,
} from "../deps.js";
import { ASK_USER_QUESTION_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from "@zcode/contracts";
import { EXPLORE_AGENT_TYPE } from "../../subagent/explore.js";

export const RUNTIME_MODE_REMINDER_CONFIG = Object.freeze({
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
});

const planResearchAgentCount = 3;

function buildPlanWorkflow() {
  return `## Plan Workflow

### Phase 1: Initial Understanding
Goal: Understand the user's requested deliverable, authorization and existing implementation using the currently available read-only tools.

1. Focus on understanding the user's request and the code associated with their request. Actively search for existing functions, utilities, and patterns that can be reused \u2014 avoid proposing new code when suitable implementations already exist.

2. If Agent and ${EXPLORE_AGENT_TYPE} are available and delegation is permitted, you may delegate independent read-only research to up to ${planResearchAgentCount} agents, each with a bounded question and evidence requirements. Otherwise research directly. Do not duplicate delegated searches or assume unavailable tools exist.

### Phase 2: Design
Goal: Design an implementation approach.

**Guidelines:**
- Use the context gathered in Phase 1, including relevant files and code paths.
- Account for the user's requirements and constraints.
- Produce a concrete implementation plan that is detailed enough to execute.
- Consider useful perspectives for the task type:
  - New feature: simplicity vs performance vs maintainability
  - Bug fix: root cause vs workaround vs prevention
  - Refactoring: minimal change vs clean architecture

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use ${ASK_USER_QUESTION_TOOL_NAME}, if available, only for unresolved decisions the user must make. Do not ask routine implementation questions or repeat an existing authorization.

### Phase 4: Call ${EXIT_PLAN_MODE_TOOL_NAME}
When the plan is complete, submit its full content through ${EXIT_PLAN_MODE_TOOL_NAME} for approval before implementation. If a required clarification or approval tool is unavailable, report that specific blocker; do not invent a tool or bypass read-only mode. A task asking only for findings can end with those findings without implementation.

**Important:** Use ${ASK_USER_QUESTION_TOOL_NAME} ONLY to clarify requirements or choose between approaches. Use ${EXIT_PLAN_MODE_TOOL_NAME} to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no AskUserQuestion. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use ${EXIT_PLAN_MODE_TOOL_NAME}.

NOTE: Use evidence and sensible defaults for routine choices. Ask only when a real unresolved decision would change the authorized outcome.`;
}

const PLAN_MODE_FULL_REMINDER = [
  "Plan mode is active and read-only. Do not edit files, run mutating commands, change configs or make commits. Complete the plan and use the existing ExitPlanMode approval flow before implementation; prior implementation authorization does not bypass this active gate.",
  buildPlanWorkflow(),
];

const PLAN_MODE_SPARSE_REMINDER = [
  `Plan mode is still read-only. Use available tools to resolve facts, ${ASK_USER_QUESTION_TOOL_NAME} only for blocking user decisions, and ${EXIT_PLAN_MODE_TOOL_NAME} for plan approval before implementation. If a required tool is unavailable, report the blocker. Analysis-only requests may end with findings. Never bypass the active plan gate.`,
];

const PLAN_MODE_EXIT_REMINDER = [
  "## Exited Plan Mode",
  "",
  `You have exited plan mode. Proceed within the approved scope; current tool permissions and file write checks still apply.`,
];

export const TODO_REMINDER_CONFIG = Object.freeze({
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
});

export interface TodoReminderTurnCounts {
  turnsSinceLastTodoWrite: number;
  turnsSinceLastReminder: number;
}

export function buildDateChangeReminderBody(_previousDate: string, currentDate: string): string {
  return `The date has changed. Today's date is now ${currentDate}. DO NOT mention this to the user explicitly because they are already aware.`;
}

export function runtimeMetadataForSyntheticUserMessageSource(
  source: SyntheticUserMessageSource,
): RuntimeMessageMetadata {
  if (
    source === "background_task" ||
    source === "subagent_message" ||
    source === "shared_context"
  ) {
    return legacySyntheticRuntimeMetadata();
  }
  if (source === "subagent") {
    return systemReminderRuntimeMetadata("queued_system_notification");
  }
  if (source === "todo_reminder") {
    return todoReminderRuntimeMetadata();
  }
  if (source === "goal_state_change") {
    return systemReminderRuntimeMetadata("goal_state_change");
  }
  if (source === "agent_listing_delta") {
    return systemReminderRuntimeMetadata(source);
  }
  if (source === "plugin_reference") {
    return systemReminderRuntimeMetadata("plugin_reference");
  }
  if (source === "selection_side_chat") {
    return systemReminderRuntimeMetadata("selection_side_chat");
  }
  if (source === "bot_topic_context") return systemReminderRuntimeMetadata("bot_topic_context");
  if (source === "goal-continuation") {
    return systemReminderRuntimeMetadata("target_continuation");
  }
  return systemReminderRuntimeMetadata("rewind_notice");
}

export function getTodoReminderTurnCounts(
  entries: readonly RuntimeMessageEntry[],
): TodoReminderTurnCounts {
  let assistantTurnsAfterCurrentEntry = 0;
  let turnsSinceLastTodoWrite: number | undefined;
  let turnsSinceLastReminder: number | undefined;

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (turnsSinceLastReminder === undefined && entry.metadata?.source === "todo_reminder") {
      turnsSinceLastReminder = assistantTurnsAfterCurrentEntry;
    }
    if (turnsSinceLastTodoWrite !== undefined && turnsSinceLastReminder !== undefined) {
      break;
    }

    if (isRuntimeAttachmentEntry(entry)) continue;
    if (entry.message.role !== "assistant") continue;

    if (
      turnsSinceLastTodoWrite === undefined &&
      entry.message.toolCalls?.some((toolCall) => toolCall.name === "TodoWrite")
    ) {
      turnsSinceLastTodoWrite = assistantTurnsAfterCurrentEntry;
    }
    assistantTurnsAfterCurrentEntry++;
    if (turnsSinceLastTodoWrite !== undefined && turnsSinceLastReminder !== undefined) {
      break;
    }
  }

  return {
    turnsSinceLastReminder: turnsSinceLastReminder ?? assistantTurnsAfterCurrentEntry,
    turnsSinceLastTodoWrite: turnsSinceLastTodoWrite ?? assistantTurnsAfterCurrentEntry,
  };
}

export function shouldBuildTodoReminder(entries: readonly RuntimeMessageEntry[]): boolean {
  const counts = getTodoReminderTurnCounts(entries);
  return (
    counts.turnsSinceLastTodoWrite >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    counts.turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  );
}

export function buildTodoReminderBody(todos: readonly TodoItem[]): string {
  const lines = [
    "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable.",
  ];
  if (todos.length > 0) {
    const currentTodos = `[${formatTodoListForReminder(todos).join("\n")}]`;
    lines.push("", "Here are the existing contents of your todo list:", "", currentTodos);
  }
  return lines.join("\n");
}

export function buildRuntimeModeReminderBody(
  entries: readonly RuntimeMessageEntry[],
  mode: CollaborationMode,
  planEnabled = mode === "plan",
): string | null {
  if (!planEnabled) return null;

  const { foundRuntimeModeReminder, humanTurnsSinceReminder } =
    getRuntimeModeReminderTurnCount(entries);
  if (
    foundRuntimeModeReminder &&
    humanTurnsSinceReminder < RUNTIME_MODE_REMINDER_CONFIG.TURNS_BETWEEN_ATTACHMENTS
  ) {
    return null;
  }

  const nextReminderCount = countRuntimeModeReminders(entries) + 1;
  const reminderLines =
    nextReminderCount % RUNTIME_MODE_REMINDER_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS === 1
      ? PLAN_MODE_FULL_REMINDER
      : PLAN_MODE_SPARSE_REMINDER;
  return reminderLines.join("\n");
}

export function buildPlanModeExitReminderBody(): string {
  return PLAN_MODE_EXIT_REMINDER.join("\n");
}

export function buildRuntimeOutputStyleReminderBody(
  outputStyle: OutputStylePromptConfig | undefined,
): string | null {
  const activePrompt = outputStyle?.prompt.trim();
  if (!outputStyle || !activePrompt) {
    return null;
  }

  return `${outputStyle.name} output style is active. Remember to follow the specific guidelines for this style.`;
}

function formatTodoListForReminder(todos: readonly TodoItem[]): string[] {
  return todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`);
}

function getRuntimeModeReminderTurnCount(entries: readonly RuntimeMessageEntry[]): {
  foundRuntimeModeReminder: boolean;
  humanTurnsSinceReminder: number;
} {
  let humanTurnsSinceReminder = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.metadata?.source === "runtime_mode") {
      return { foundRuntimeModeReminder: true, humanTurnsSinceReminder };
    }
    if (isRuntimeAttachmentEntry(entry)) continue;
    if (entry.message.role === "user" && entry.metadata?.source === "real_user") {
      humanTurnsSinceReminder++;
    }
  }
  return { foundRuntimeModeReminder: false, humanTurnsSinceReminder };
}

function countRuntimeModeReminders(entries: readonly RuntimeMessageEntry[]): number {
  return entries.reduce(
    (count, entry) => count + (entry.metadata?.source === "runtime_mode" ? 1 : 0),
    0,
  );
}
