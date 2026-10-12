// Modified by ZCode Feiyu.
import type { ConfigResult } from "@zcode/adapters/config";
import type { AgentRuntimeConfig } from "@zcode/core";
import type { Logger, SessionId } from "@zcode/contracts";

import { createSessionEvent, type TraceContext } from "@zcode/contracts";
import { AgentRuntime } from "@zcode/core";

import type { ZCodeAppOptions } from "./types.js";

import { createWorkspaceHookRuntimeSecurity } from "./workspace-hook-trust.js";
// 装配阶段复用同一实例与闭包，不另建运行状态或副作用路径。
export function createAppWorkspaceHookSecurity(input: {
  appVersion: string;
  logger: Logger;
  options: ZCodeAppOptions;
  configResult: ConfigResult;
  runtimeConfig: AgentRuntimeConfig;
  sessionId: SessionId;
  workingDirectory: string;
  readRuntime: () => AgentRuntime | undefined;
  traceContext: TraceContext;
}) {
  const {
    appVersion,
    logger,
    options,
    configResult,
    runtimeConfig,
    sessionId,
    workingDirectory,
    readRuntime,
    traceContext,
  } = input;

  const workspaceHookRuntimeSecurity = createWorkspaceHookRuntimeSecurity({
    appVersion,
    logger,
    projectConfigPath: options.projectConfigPath,
    policy: options.workspaceHookPolicy,
    policyProvider: options.workspaceHookPolicyProvider,
    reviewHost: options.workspaceHookReviewHost,
    workspaceHookTrustEnabled: options.workspaceHookTrustEnabled,
    runtimeRoot: configResult.sources.project.workspaceHookRuntimeRoot ?? {
      // Fallback 只在 config-factory 未导出时生效（理论上不会发生）。
      // 此处原本无条件按单层 runtimeConfig.hooks 重建 runtimeRoot，与
      // config-factory 遍历 default/user/project/env/cli 全部层的推导不一致，
      // 导致 review 快照与 toggle 重建的 bundleDigest 不同，
      // 「审核中 toggle」被误报为 workspace_hooks_snapshot_mismatch。
      enabled: runtimeConfig.hooks?.enabled === true,
      timeoutMs: runtimeConfig.hooks?.timeoutMs ?? 60_000,
      maxOutputBytes: runtimeConfig.hooks?.maxOutputBytes ?? 32_768,
    },
    sessionId,
    snapshot: configResult.sources.project.workspaceHookSnapshot,
    userConfigPath: configResult.sources.user.path,
    workingDirectory,
    ...(options.workspaceHookReviewHost
      ? {
          emitReviewEvent: async (event) => {
            // 该回调发生在 runtime 构造后，必须读取原闭包的实时值。
            const runtime = readRuntime();
            if (!runtime) throw new Error("ZCode runtime is not initialized yet.");
            await runtime.appendEvent(
              createSessionEvent(event.type, sessionId, event.payload, {
                traceId: traceContext.traceId,
              }),
              traceContext,
            );
          },
          emitAdmissionEvent: async (event) => {
            // 该回调与 review 共用原 runtime，不能捕获构造前的空值。
            const runtime = readRuntime();
            if (!runtime) throw new Error("ZCode runtime is not initialized yet.");
            await runtime.appendEvent(
              createSessionEvent(event.type, sessionId, event.payload, {
                traceId: traceContext.traceId,
              }),
              traceContext,
            );
          },
        }
      : {}),
  });
  return { workspaceHookRuntimeSecurity };
}
