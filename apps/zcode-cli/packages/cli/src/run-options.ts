// Modified by ZCode Feiyu.
import { parseGlobalArgs } from "./arguments.js";
import { type PresentationSurface } from "@zcode/core";
import { getZCodeCopy, isUiLocale, type UiLocale } from "@zcode/i18n";
import type { GlobalOptions, GlobalOutputFormat } from "@zcode/shared-types";
import { type PluginsCommandFlags } from "./plugins-command.js";
import type { CliPermissionMode, CliTargetRequest } from "./cli-types.js";

export const EMPTY_TARGET_ERROR = "--target requires non-empty text.";

export const DEFAULT_HEADLESS_PROMPT_MODE: CliPermissionMode = "yolo";

export const FORCE_MCS_SCOPE_ERROR =
  "--force-mcs can only be used with --prompt, --target, or tui.";

export const TARGET_REPLACE_REQUIRES_TARGET_ERROR = "--target-replace requires --target.";

export const TARGET_CONFLICTS_WITH_PROMPT_ERROR =
  '--target cannot be used with --prompt. Use either --target <objective> or --prompt "/goal <objective>".';

export const BROWSER_EXECUTABLE_REQUIRES_HEADLESS_ERROR =
  "--browser-executable requires --browser-use=headless.";

export const BROWSER_USE_SCOPE_ERROR =
  "--browser-use=headless can only be used with --prompt, --target, or tui.";

export const SURFACE_SCOPE_ERROR =
  "--surface can only be used with --prompt, --target, app-server, or agent-server.";

export const MEMORY_BENCH_SCOPE_ERROR = "--memory-bench can only be used with -p/--prompt.";

export const pluginsCommandFlags = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
): PluginsCommandFlags => ({
  ...(values.all === true ? { all: true } : {}),
  ...(values.available === true ? { available: true } : {}),
  ...(values["keep-data"] === true ? { keepData: true } : {}),
  ...(typeof values.scope === "string" ? { scope: values.scope } : {}),
  ...(Array.isArray(values.sparse) ? { sparse: values.sparse as string[] } : {}),
});

export const commandName = (positionals: string[]): string => positionals[0] ?? "tui";

export const isForceMcsSupportedInvocation = (input: {
  positionals: string[];
  prompt?: string;
  targetRequest?: CliTargetRequest;
}): boolean =>
  typeof input.prompt === "string" ||
  input.targetRequest !== undefined ||
  commandName(input.positionals) === "tui";

export const isPresentationSurfaceSupportedInvocation = (input: {
  positionals: string[];
  prompt?: string;
  targetRequest?: CliTargetRequest;
}): boolean => {
  const command = commandName(input.positionals);
  return (
    typeof input.prompt === "string" ||
    input.targetRequest !== undefined ||
    command === "app-server" ||
    command === "agent-server"
  );
};

export const globalOptions = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
  locale: UiLocale | undefined,
  detectedLocale: GlobalOptions["detectedLocale"],
  browserUse: GlobalOptions["browserUse"],
  browserExecutable: GlobalOptions["browserExecutable"],
  outputFormat: GlobalOptions["outputFormat"],
): GlobalOptions => {
  return {
    browserExecutable,
    browserUse,
    detectedLocale,
    force: values.force === true,
    json: values.json === true,
    locale,
    ...(values["memory-bench"] === true ? { memoryBench: true } : {}),
    noColor: values["no-color"] === true,
    ...(outputFormat ? { outputFormat } : {}),
    verbose: values.verbose === true,
  };
};

export const OUTPUT_FORMATS: readonly GlobalOutputFormat[] = ["text", "json", "stream-json"];

export /**
 * Validate --output-format. Rejecting an unknown value matters more than it
 * looks: a caller that misspells it would otherwise get plain text back and
 * silently parse nothing.
 */
const normalizeOutputFormat = (value: string | undefined): GlobalOutputFormat | undefined => {
  if (value === undefined) return undefined;
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as GlobalOutputFormat;
  throw new Error(
    `--output-format must be one of ${OUTPUT_FORMATS.join(", ")} (received: ${value}).`,
  );
};

export const normalizeLocaleOption = (value: string | undefined): UiLocale | undefined => {
  if (value === undefined) return undefined;
  if (isUiLocale(value)) return value;
  throw new Error(getZCodeCopy().cli.errors.localeUnsupported(value));
};

export const normalizePromptMode = (value: string | undefined): CliPermissionMode | undefined => {
  if (value === undefined) return undefined;
  const mode = value.toLowerCase();
  if (
    mode === "build" ||
    mode === "plan" ||
    mode === "edit" ||
    mode === "yolo" ||
    mode === "guarded"
  )
    return mode;
  throw new Error(
    `Unsupported --mode value: ${value}. Supported modes: build, edit, plan, yolo, guarded.`,
  );
};

export const normalizeBrowserUse = (value: string | undefined): GlobalOptions["browserUse"] => {
  if (value === undefined) return undefined;
  if (value.toLowerCase() === "headless") return "headless";
  throw new Error(`Unsupported --browser-use value: ${value}. Supported value: headless.`);
};

export const normalizePresentationSurface = (value: string | undefined): PresentationSurface => {
  if (value === undefined || value.toLowerCase() === "terminal") return "terminal";
  if (value.toLowerCase() === "desktop") return "zcode_desktop";
  throw new Error(`Unsupported --surface value: ${value}. Supported surfaces: terminal, desktop.`);
};

export const normalizeTargetRequest = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
): CliTargetRequest | undefined => {
  const rawTarget = values.target as string | undefined;
  const replaceExisting = values["target-replace"] === true;
  if (rawTarget === undefined) {
    if (replaceExisting) {
      throw new Error(TARGET_REPLACE_REQUIRES_TARGET_ERROR);
    }
    return undefined;
  }

  const objective = rawTarget.trim();
  if (objective.length === 0) {
    throw new Error(EMPTY_TARGET_ERROR);
  }

  return {
    objective,
    replaceExisting,
  };
};

export const buildHeadlessTargetCommand = (targetRequest: CliTargetRequest): string =>
  targetRequest.replaceExisting
    ? `/goal replace ${targetRequest.objective}`
    : `/goal ${targetRequest.objective}`;
