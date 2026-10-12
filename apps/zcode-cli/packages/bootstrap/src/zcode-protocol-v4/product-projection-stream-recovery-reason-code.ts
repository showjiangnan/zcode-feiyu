// Modified by ZCode Feiyu.
import type { StreamRecoveryStartedPayload, ToolResultDisplayPayload } from "@zcode/contracts";
import type {
  BackgroundWorkKind,
  BackgroundWorkSummary,
  ToolCallDisplay,
  UserInputQuestionPayload,
} from "@zcode/shared/zcode-protocol-v4";

export function streamRecoveryReasonCode(
  failureKind: StreamRecoveryStartedPayload["failureKind"],
): string {
  switch (failureKind) {
    case "provider_timeout":
      return "fault.network.timeout";
    case "provider_network_error":
      return "fault.network.unreachable";
    case "provider_stream_error":
      return "fault.network.sseDisconnected";
    case "provider_turn_failed":
    case "unknown":
      return "fault.provider.requestFailed";
  }
}

export function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function nonNegativeInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/**
 * 事件载荷上的显式 taskKind → 抽屉分区（= summary.kind）。
 *
 * 两边取值同源（shared 的 BACKGROUND_WORK_KINDS），这里仍然逐个列出、且**不写 default**：
 * 直传会让「新增取值」在投影里静默生效，而漏掉一个 case 时 TypeScript 会在这里报错。
 * 与 `bash` / `subagent` / `workflow` 的后备推断（resolveZCodeBackgroundTaskControlKind，
 * 只服务没有 taskKind 的旧事件）刻意分开：新取值不允许被推断出来。
 */
export function explicitBackgroundWorkKind(
  kind: BackgroundWorkKind | undefined,
): BackgroundWorkSummary["kind"] | undefined {
  switch (kind) {
    case undefined:
      return undefined;
    case "bash":
      return "bash";
    case "subagent":
      return "subagent";
    case "workflow":
      return "workflow";
    case "memory_extraction":
      return "memory_extraction";
    case "memory_review":
      return "memory_review";
    case "proactive":
      return "proactive";
  }
}

export interface FileToolInputPreviewState {
  lastPublishedAt: number | null;
  pendingAppend: string;
}

export interface HighspeedToolInterval {
  startedAt: number;
  endedAt?: number;
}

export type TurnModelBaseline =
  | { kind: "silentInitial" }
  | { kind: "sourceLess" }
  | { kind: "known"; provider: string; model: string; thought: string };

export function isAskUserQuestionToolName(value: string | undefined): boolean {
  return value === "AskUserQuestion";
}

/**
 * 把 core 的 tool display 收窄成 v4 协议能承载的那几种 kind。
 *
 * 这份白名单原先在每个投影点各写一份内联判断，引入
 * create_workflow display 时漏改了其中一份，实时投影把图整个丢掉、而 hydration 路径没过滤，
 * 于是桌面端只有重载之后才看得到。收成一个谓词后，所有投影点共用同一份名单。
 */
export function toProtocolToolCallDisplay(
  display: ToolResultDisplayPayload | undefined,
): ToolCallDisplay | undefined {
  if (!display) return undefined;
  switch (display.kind) {
    case "node_repl_images":
    case "task_output":
    case "respond_to_coordinator":
    case "mcp_tool":
    case "create_workflow":
    // 观察类工作流工具的五个 display kind——shared 侧 toolCallDisplaySchema 已同步加
    // 成员，这里放行后 UI 才能在 row.display 上拿到结构化载荷。
    case "get_workflow_run":
    case "list_workflow_runs":
    case "eval_workflow_snippet":
    case "saved_workflow_list":
    case "list_models":
    // ResumeWorkflowRun 的恢复卡。
    case "resume_workflow_run":
      return display;
    default:
      return undefined;
  }
}

export function stringifyToolInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
}

export function isExitPlanModeToolName(value: string | undefined): boolean {
  return value === "ExitPlanMode";
}

export function createExitPlanModeApprovalQuestion(reason: string): UserInputQuestionPayload {
  return {
    question: reason,
    header: "Plan",
    options: [
      {
        value: "approve",
        label: "Approve",
        description: "Exit plan mode and start implementation.",
      },
    ],
  };
}

export function readAskUserQuestionPayloadQuestions(input: unknown): UserInputQuestionPayload[] {
  const rawQuestions = readRawAskUserQuestions(input);
  return rawQuestions
    .map(normalizeAskUserQuestionPayloadQuestion)
    .filter((question): question is UserInputQuestionPayload => question !== null);
}

export function readRawAskUserQuestions(input: unknown): unknown[] {
  if (!isPlainRecord(input)) {
    return [];
  }
  if (Array.isArray(input.questions)) {
    return input.questions;
  }
  return typeof input.question === "string" && Array.isArray(input.options) ? [input] : [];
}

export function normalizeAskUserQuestionPayloadQuestion(
  value: unknown,
): UserInputQuestionPayload | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const question = nonEmptyString(value.question);
  const header = nonEmptyString(value.header) ?? question;
  const rawOptions = Array.isArray(value.options) ? value.options : [];
  const options = rawOptions
    .map(normalizeAskUserQuestionPayloadOption)
    .filter((option): option is UserInputQuestionPayload["options"][number] => option !== null);
  if (!question || !header || options.length === 0) {
    return null;
  }
  return {
    question,
    header,
    options,
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
  };
}

export function normalizeAskUserQuestionPayloadOption(
  value: unknown,
): UserInputQuestionPayload["options"][number] | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const label = nonEmptyString(value.label) ?? nonEmptyString(value.value);
  const optionValue = nonEmptyString(value.value) ?? label;
  if (!label || !optionValue) {
    return null;
  }
  return {
    value: optionValue,
    label,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.preview === "string" ? { preview: value.preview } : {}),
  };
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
