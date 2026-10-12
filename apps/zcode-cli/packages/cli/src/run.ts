// Modified by ZCode Feiyu.
import { extractDisallowedToolsArgs, parseGlobalArgs } from "./arguments.js";
import { createNodeLoggerFactory } from "@zcode/adapters";
import { type PresentationSurface } from "@zcode/core";
import { type UiLocale } from "@zcode/i18n";
import type { RunContext, GlobalOptions } from "@zcode/shared-types";
import { applyCliRuntimeEnvSanitization, loadCliDotenv, prepareCliRuntimeEnv } from "./env.js";
import { runHooksCommand } from "./hooks-trust-command.js";
import { detectCliLocale } from "./locale.js";
import { runEmbeddedSearchCli } from "./internal-search/embedded-search-cli.js";
import { runCommandsCommand } from "./commands-command.js";
import { resolveCliCwd } from "./cwd.js";
import { runLoginCommand, runLogoutCommand } from "./login-command.js";
import { isPluginHostInvocation, runPluginHostCommand } from "./plugin-host-command.js";
import { isDwfChildInvocation, runDwfChildCommand } from "./dwf-child-command.js";
import { runPrompt } from "./prompt-command.js";
import { runPluginsCommand } from "./plugins-command.js";
import { runSkillsCommand } from "./skills-command.js";
import { runTuiCommand } from "./tui-command.js";
import {
  DEFAULT_CLI_WORKFLOW_MODE,
  normalizeWorkflowModeOption,
  WORKFLOW_MODE_SCOPE_ERROR,
} from "./workflow-mode.js";
import type {
  CliPermissionMode,
  CliResumeRequest,
  CliTargetRequest,
  RunDependencies,
} from "./cli-types.js";
import { version, writeHelp, runZCodeProtocolCommand, runDoctor } from "./run-host.js";
import {
  normalizeLocaleOption,
  normalizePromptMode,
  normalizeBrowserUse,
  normalizePresentationSurface,
  BROWSER_EXECUTABLE_REQUIRES_HEADLESS_ERROR,
  normalizeOutputFormat,
  globalOptions,
  normalizeTargetRequest,
  TARGET_CONFLICTS_WITH_PROMPT_ERROR,
  isPresentationSurfaceSupportedInvocation,
  SURFACE_SCOPE_ERROR,
  MEMORY_BENCH_SCOPE_ERROR,
  isForceMcsSupportedInvocation,
  BROWSER_USE_SCOPE_ERROR,
  FORCE_MCS_SCOPE_ERROR,
  DEFAULT_HEADLESS_PROMPT_MODE,
  buildHeadlessTargetCommand,
  commandName,
  pluginsCommandFlags,
} from "./run-options.js";

export const run = async (ctx: RunContext, deps: RunDependencies = {}): Promise<number> => {
  if (ctx.argv[0] === "__internal-search") {
    return runEmbeddedSearchCli(ctx.argv.slice(1), {
      cwd: (deps.cwd ?? process.cwd)(),
      stderr: ctx.stderr,
      stdin: ctx.stdin,
      stdout: ctx.stdout,
    });
  }

  if (isPluginHostInvocation(ctx.argv)) {
    return await runPluginHostCommand(ctx, ctx.argv.slice(1));
  }

  // 与 plugin host 同理，且必须同样在 parseArgs 之前：SEA 下 dwf 的沙箱子进程是本二进制的
  // 自 re-exec，argv 末位是入口文件路径——交给严格 parseArgs 只会报未知参数。
  if (isDwfChildInvocation(ctx.argv)) {
    return await runDwfChildCommand(ctx, ctx.argv.slice(1));
  }

  if (ctx.argv[0] === "hooks") {
    return await runHooksCommand(ctx, deps, version);
  }

  let parsed: ReturnType<typeof parseGlobalArgs>;
  let toolDisallowlist: readonly string[] | undefined;

  try {
    const extracted = extractDisallowedToolsArgs(ctx.argv);
    parsed = parseGlobalArgs(extracted.args);
    toolDisallowlist = extracted.toolDisallowlist;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n\n`);
    writeHelp(ctx.stderr);
    return 1;
  }

  let locale: UiLocale | undefined;
  try {
    locale = normalizeLocaleOption(parsed.values.locale as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  let mode: CliPermissionMode | undefined;
  let workflowModeOption: ReturnType<typeof normalizeWorkflowModeOption>;
  let browserUse: GlobalOptions["browserUse"];
  let presentationSurface: PresentationSurface;
  try {
    mode = normalizePromptMode(parsed.values.mode as string | undefined);
    workflowModeOption = normalizeWorkflowModeOption(
      parsed.values["workflow-mode"] as string | undefined,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  try {
    browserUse = normalizeBrowserUse(parsed.values["browser-use"] as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }
  try {
    presentationSurface = normalizePresentationSurface(parsed.values.surface as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }
  const browserExecutable = parsed.values["browser-executable"] as string | undefined;
  if (browserExecutable !== undefined && browserUse !== "headless") {
    ctx.stderr.write(`${BROWSER_EXECUTABLE_REQUIRES_HEADLESS_ERROR}\n`);
    return 1;
  }

  const resumeRequest: CliResumeRequest = {
    continueSession: parsed.values.continue === true,
    resumeSessionId: parsed.values.resume as string | undefined,
  };
  if (resumeRequest.continueSession && resumeRequest.resumeSessionId) {
    ctx.stderr.write("--resume and --continue cannot be used together.\n");
    return 1;
  }

  const env = prepareCliRuntimeEnv(deps.env ?? process.env);
  const detectedLocale = detectCliLocale(env);
  let outputFormat: GlobalOptions["outputFormat"];
  try {
    outputFormat = normalizeOutputFormat(parsed.values["output-format"] as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }
  const options = globalOptions(
    parsed.values,
    locale,
    detectedLocale,
    browserUse,
    browserExecutable,
    outputFormat,
  );
  const forceMcs = parsed.values["force-mcs"] === true;
  let targetRequest: CliTargetRequest | undefined;
  try {
    targetRequest = normalizeTargetRequest(parsed.values);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  if (targetRequest && typeof parsed.values.prompt === "string") {
    ctx.stderr.write(`${TARGET_CONFLICTS_WITH_PROMPT_ERROR}\n`);
    return 1;
  }

  if (
    parsed.values.surface !== undefined &&
    !isPresentationSurfaceSupportedInvocation({
      positionals: parsed.positionals,
      prompt: parsed.values.prompt as string | undefined,
      targetRequest,
    })
  ) {
    ctx.stderr.write(`${SURFACE_SCOPE_ERROR}\n`);
    return 1;
  }

  if (parsed.values.help === true) {
    writeHelp(ctx.stdout, options.locale, options.detectedLocale);
    return 0;
  }

  if (parsed.values.version === true) {
    ctx.stdout.write(`${version}\n`);
    return 0;
  }

  if (
    options.memoryBench &&
    (typeof parsed.values.prompt !== "string" || parsed.positionals.length > 0)
  ) {
    ctx.stderr.write(`${MEMORY_BENCH_SCOPE_ERROR}\n`);
    return 1;
  }

  if (
    browserUse === "headless" &&
    !isForceMcsSupportedInvocation({
      positionals: parsed.positionals,
      prompt: parsed.values.prompt as string | undefined,
      targetRequest,
    })
  ) {
    ctx.stderr.write(`${BROWSER_USE_SCOPE_ERROR}\n`);
    return 1;
  }

  // app-server 的 mode 归 Host 决定（launch.md「The standalone CLI: `--workflow-mode`」），
  // 其余子命令不建会话；作用域与 --force-mcs 相同：只有 --prompt、--target 与 TUI。
  if (
    workflowModeOption !== undefined &&
    !isForceMcsSupportedInvocation({
      positionals: parsed.positionals,
      prompt: parsed.values.prompt as string | undefined,
      targetRequest,
    })
  ) {
    ctx.stderr.write(`${WORKFLOW_MODE_SCOPE_ERROR}\n`);
    return 1;
  }
  const workflowMode = workflowModeOption ?? DEFAULT_CLI_WORKFLOW_MODE;

  if (
    forceMcs &&
    !isForceMcsSupportedInvocation({
      positionals: parsed.positionals,
      prompt: parsed.values.prompt as string | undefined,
      targetRequest,
    })
  ) {
    ctx.stderr.write(`${FORCE_MCS_SCOPE_ERROR}\n`);
    return 1;
  }

  let workingDirectory: string;
  try {
    workingDirectory = resolveCliCwd({
      cwd: deps.cwd ?? process.cwd,
      requestedCwd: parsed.values.cwd as string | undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  const commandDeps: RunDependencies = {
    ...deps,
    cwd: () => workingDirectory,
    env,
    logger:
      deps.logger ??
      createNodeLoggerFactory({ env }).createLogger("zcode").child({ module: "cli" }),
    loadDotenv: (dotenvOptions = {}) => {
      const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)(dotenvOptions);
      applyCliRuntimeEnvSanitization(dotenvOptions.env ?? env);
      return dotenvResult;
    },
  };

  if (typeof parsed.values.prompt === "string") {
    return await runPrompt(
      ctx,
      parsed.values.prompt,
      parsed.values.attach ?? [],
      options,
      commandDeps,
      version,
      mode ?? DEFAULT_HEADLESS_PROMPT_MODE,
      resumeRequest,
      toolDisallowlist,
      forceMcs,
      presentationSurface,
      workflowMode,
    );
  }

  if (targetRequest) {
    return await runPrompt(
      ctx,
      buildHeadlessTargetCommand(targetRequest),
      [],
      options,
      commandDeps,
      version,
      mode,
      resumeRequest,
      toolDisallowlist,
      forceMcs,
      presentationSurface,
      workflowMode,
    );
  }

  switch (commandName(parsed.positionals)) {
    case "help":
      writeHelp(ctx.stdout, options.locale, options.detectedLocale);
      return 0;
    case "version":
      ctx.stdout.write(`${version}\n`);
      return 0;
    case "agent-server":
    case "app-server":
      return await runZCodeProtocolCommand(
        ctx,
        options,
        commandDeps,
        presentationSurface,
        parsed.values["prepare-storage"] === true,
      );
    case "doctor":
      return runDoctor(ctx, options, workingDirectory);
    case "login":
      return await runLoginCommand(
        ctx,
        options,
        commandDeps,
        parsed.values["no-browser"] === true,
        parsed.positionals.slice(1),
      );
    case "logout":
      return await runLogoutCommand(ctx, options, commandDeps);
    case "commands":
      return await runCommandsCommand(ctx, options, commandDeps, parsed.positionals.slice(1));
    case "plugin":
    case "plugins":
      return await runPluginsCommand(
        ctx,
        options,
        commandDeps,
        parsed.positionals.slice(1),
        pluginsCommandFlags(parsed.values),
      );
    case "skills":
      return await runSkillsCommand(ctx, options, commandDeps, parsed.positionals.slice(1));
    case "tui":
      return await runTuiCommand(
        ctx,
        options,
        commandDeps,
        version,
        mode,
        resumeRequest,
        toolDisallowlist,
        forceMcs,
        workflowMode,
      );
    default:
      ctx.stderr.write(`Unknown command: ${commandName(parsed.positionals)}\n\n`);
      writeHelp(ctx.stderr, options.locale, options.detectedLocale);
      return 1;
  }
};

export type { RunDependencies } from "./cli-types.js";
