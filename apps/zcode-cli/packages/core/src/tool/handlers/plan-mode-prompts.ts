// Modified by ZCode Feiyu.
// ============================================================
// Plan Mode Tool Provider Prompts
// ============================================================

export function createEnterPlanModeProviderDescription(
  options: {
    embeddedSearchEnabled?: boolean;
  } = {},
): string {
  const explorationTools = options.embeddedSearchEnabled
    ? "`find`/Glob, `grep`/Grep, and Read"
    : "Glob, Grep, and Read";

  // 旧文案把复杂度当审批条件，且误称进入计划需要批准；以当前模式和真实决策为准。
  return `Enter read-only planning mode when the user asks for a plan before implementation, or a genuine unresolved scope or architecture decision needs their approval.

- Continue already authorized implementation when the requirements and boundaries are clear. Complexity, file count, or ordinary implementation choices alone do not require plan mode or renewed approval.
- For an analysis, review, or explanation request, investigate and return findings without implementing changes or entering plan mode merely to report them.
- Resolve code facts with ${explorationTools}. Use only tools available in the current catalog; delegate only independent work when delegation is available and permitted.
- Use AskUserQuestion, if available, only for a blocking decision the user must make. Do not substitute plan mode for a small clarification.
- EnterPlanMode changes the session to read-only planning; it does not itself request user approval. Once plan mode is active, keep its read-only limits and submit the complete plan through ExitPlanMode for approval before implementation.
- Existing authorization never overrides runtime permission checks or an active plan-mode gate.`;
}

export const ENTER_PLAN_MODE_PROVIDER_DESCRIPTION = createEnterPlanModeProviderDescription();

export const EXIT_PLAN_MODE_MODEL_INSTRUCTIONS = [
  `Use this tool when you are in plan mode and have finished writing your plan and are ready for user approval.

## How This Tool Works
- You should have already explored the codebase and finalized the plan you want the user to review
- This tool DOES take the plan content as the required plan parameter in ZCode
- Pass the complete plan in the plan field; the user will review that content before approving implementation
- This tool simply signals that you're done planning and ready for the user to review and approve
- The user will see the contents of the plan parameter when they review it

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskUserQuestion before finalizing your plan
- Once your plan is finalized, use THIS tool to request approval

**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.

## Examples

1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.
`,
] as const;
