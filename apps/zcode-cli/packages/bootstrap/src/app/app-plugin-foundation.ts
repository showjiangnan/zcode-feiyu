// Modified by ZCode Feiyu.
import type { ConfigResult } from "@zcode/adapters/config";
import type { Logger, SessionId } from "@zcode/contracts";
import { resolvePath } from "@zcode/adapters/config";

import { type TraceContext } from "@zcode/contracts";

import { resolveZCodeRuntimeEnv } from "@zcode/shared";
import { SUGGESTED_PROMPT_ENTRY_TYPE, suggestedPromptConsentSchema } from "@zcode/shared";

import { join } from "node:path";
import { subagentProfilesFromSnapshot } from "../subagent-runtime-config.js";

import { StartupTimer } from "../startup-logging.js";
import {
  loadPluginAgentTemplates,
  loadZCodeAgentProfiles,
  resolvePluginAgentProfiles,
} from "../subagents.js";

import { resolveBuiltInNodeReplMcpServers } from "./built-in-node-repl.js";
import { resolveBundledSkillRoots } from "./bundled-skills.js";

import { restoreImageGenerationPort } from "./image-generation-snapshot.js";

import { getCliStorageRoot, getModelIoDir, projectIdFromDirectory } from "./paths.js";

import { resolvePluginRuntimeFeatures } from "./plugin-runtime-features.js";

import { resolveAppRuntimeConfig } from "./runtime-config.js";

import {
  asLocalSettingStore,
  openStartupSessionStore,
  readProjectPermissionMode,
} from "./session-store.js";
import { resolveStartupPlugins } from "./startup-marks.js";
import type { ZCodeAppOptions } from "./types.js";

// 装配阶段复用同一实例与闭包，不另建运行状态或副作用路径。
export async function createAppPluginFoundation(input: {
  configResult: ConfigResult;
  options: ZCodeAppOptions;
  traceContext: TraceContext;
  logger: Logger;
  workingDirectory: string;
  startupTimer: StartupTimer;
  sessionId: SessionId;
}) {
  let { options } = input;
  const { configResult, traceContext, logger, workingDirectory, startupTimer, sessionId } = input;

  const storageRoot = resolvePath(configResult.config.storage.dir);

  const cliStorageRoot = getCliStorageRoot(storageRoot);

  const modelIoDir = getModelIoDir(
    cliStorageRoot,
    resolveZCodeRuntimeEnv(options.env ?? process.env) === "development",
  );

  // 初始化与父轮必须使用同一 Host 来源，避免 CLI storage.dir 的另一份定义在首轮消失。
  const hostSubagentSnapshot = await options.readSubagentRuntimeConfig?.({
    signal: new AbortController().signal,
    traceContext,
  });

  const zcodeSubagentProfileOutcome = hostSubagentSnapshot
    ? subagentProfilesFromSnapshot(hostSubagentSnapshot)
    : await loadZCodeAgentProfiles({ logger, storageRoot, workingDirectory });

  const zcodeSubagentProfiles = zcodeSubagentProfileOutcome.profiles;

  const pluginOutcome = resolveStartupPlugins({
    cliStorageRoot,
    configResult,
    env: options.env,
    logger,
    options,
    startupTimer,
    workingDirectory,
  });

  // 随 CLI 内置的技能包（dynamic-workflows 等）：不属于任何插件，用户无法停用或卸载。
  const bundledSkillRoots = resolveBundledSkillRoots({ cliStorageRoot, logger });

  const pluginTemplates = loadPluginAgentTemplates({ logger, plugins: pluginOutcome.plugins });

  const pluginSubagentProfiles =
    hostSubagentSnapshot?.kind === "built-in-fallback"
      ? []
      : resolvePluginAgentProfiles(
          {
            logger,
            plugins: pluginOutcome.plugins,
            reservedProfileNames: zcodeSubagentProfiles.map((profile) => profile.name),
            modelSelectionOverrides: zcodeSubagentProfileOutcome.pluginAgentModelSelectionOverrides,
          },
          pluginTemplates,
        ).profiles;

  const pluginRuntimeFeatures = resolvePluginRuntimeFeatures(pluginOutcome);

  const builtInMcpServers = resolveBuiltInNodeReplMcpServers({
    pluginOutcome,
    workingDirectory,
  });

  // 用户目录已在 loader 前完成原地迁移；不能给项目/插件旧身份加内存兼容旁路。
  const subagentProfiles = [...zcodeSubagentProfiles, ...pluginSubagentProfiles];

  const ownsSessionStore = options.sessionStore === undefined;

  const sessionStore =
    options.sessionStore ?? (await openStartupSessionStore(configResult, startupTimer));

  const localSettingStore = asLocalSettingStore(sessionStore);

  options = {
    ...options,
    imageGenerationPort: await restoreImageGenerationPort(
      options.imageGenerationPort,
      sessionStore,
      sessionId,
      options.resume === true,
    ),
  };

  const projectID = projectIdFromDirectory(workingDirectory);

  const persistedMode = options.runtimeConfig?.mode
    ? undefined
    : readProjectPermissionMode(localSettingStore, projectID);

  let { configuredMcpServers, runtimeConfig, untrustedProjectMcpServers } = resolveAppRuntimeConfig(
    {
      cliStorageRoot,
      configResult,
      options,
      persistedMode,
      pluginHooks: pluginOutcome.hooks,
      pluginMcpServers: pluginOutcome.mcpServers,
      builtInMcpServers,
      pluginRuntimeFeatures,
      builtInSubagentModelSelectionOverrides:
        zcodeSubagentProfileOutcome.builtInModelSelectionOverrides,
      subagentOutputRootDir: join(cliStorageRoot, "agents"),
      subagentProfiles,
      storageRoot,
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
    },
  );
  if (options.resume === true) {
    const entries = await sessionStore.sessionEntries?.({
      sessionID: sessionId,
      type: SUGGESTED_PROMPT_ENTRY_TYPE,
    });
    const consent = suggestedPromptConsentSchema.safeParse(entries?.at(-1)?.data);
    runtimeConfig.suggestedPromptEnabled = consent.success && consent.data.enabled;
  }
  return {
    options,
    pluginRuntimeFeatures,
    runtimeConfig,
    configuredMcpServers,
    pluginOutcome,
    sessionStore,
    storageRoot,
    cliStorageRoot,
    modelIoDir,
    bundledSkillRoots,
    pluginTemplates,
    localSettingStore,
    ownsSessionStore,
    projectID,
    untrustedProjectMcpServers,
  };
}
