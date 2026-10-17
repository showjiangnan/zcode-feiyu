// Modified by ZCode Feiyu.
import type { EnvInfo, Model } from "@zcode/contracts";
import { isEnvInfoGitRepository } from "../context/sections/env-info.js";
import { READ_BEFORE_WRITE_GUIDANCE } from "../tool/read-before-write-guidance.js";
import { buildBehaviorGuidance } from "../behavior-guidance.js";

export interface SubagentEnvironmentContextOptions {
  agentPrompt: string;
  envInfo: EnvInfo;
  model?: Model;
}

export function buildSubagentCommonNotes(): string {
  return [
    "Notes:",
    READ_BEFORE_WRITE_GUIDANCE,
    buildBehaviorGuidance(),
    "- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.",
    "- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.",
    "- For clear communication with the user the assistant MUST avoid using emojis.",
    '- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.',
    "- Work only within the delegated goal, modification scope, and available tool permissions. Do not initiate unrelated work or overwrite another agent's changes.",
    "- Do not create report/summary/findings/analysis files on your own initiative. When the task explicitly requests a file or report artifact, create it at the requested path if your tool permissions allow it and return its path; otherwise report the blocker.",
    "- Return a completed, partial, or blocked result with relevant paths, evidence, checks and remaining limitations. Your parent consumes this result; it is not a direct message to the user.",
  ].join("\n");
}

export function buildSubagentEnvironmentContext(
  options: SubagentEnvironmentContextOptions,
): string {
  const { envInfo, model } = options;
  const modelLine = model
    ? [`You are powered by the model named ${model.providerId}/${model.modelId}.`]
    : [];

  return [
    "Here is useful information about the environment you are running in:",
    "<env>",
    `Working directory: ${envInfo.cwd}`,
    `Is directory a git repo: ${isEnvInfoGitRepository(envInfo) ? "Yes" : "No"}`,
    `Platform: ${envInfo.platform}`,
    `Shell: ${envInfo.shell}`,
    `OS Version: ${envInfo.osVersion}`,
    "</env>",
    ...modelLine,
  ].join("\n");
}
