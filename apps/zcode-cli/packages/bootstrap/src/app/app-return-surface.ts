// Modified by ZCode Feiyu.
import { createPluginFacadeForApp } from "./plugin-facade.js";

import type { ZCodeApp } from "./types.js";
import type { AppReturnSurfaceInput } from "./app-return-surface-types.js";
import { createAppHookSurface } from "./app-hook-surface.js";
import { createAppAttachmentSurface } from "./app-attachment-surface.js";
import { createAppWorkflowSurface } from "./app-workflow-surface.js";
export function createAppReturnSurface(input: AppReturnSurfaceInput): ZCodeApp {
  const {
    sessionId,
    traceContext,
    runtime,
    modelAdapter,
    artifactStore,
    sessionFacade,
    closeSession,
    providerModelRuntime,
    modelTelemetry,
    workflowFacade,
    scriptWorkflowFacade,
    getRuntime,
    prepareUserExecutionBoundary,
    configResult,
    options,
    workingDirectory,
    readPluginReferenceCatalog,
    resumeFromStore,
    inputFacade,
  } = input;
  return {
    sessionId,

    traceId: traceContext.traceId,

    runtime,
    ...createAppHookSurface(input),

    setModelIoFullRetentionEnabled: (enabled) =>
      modelAdapter.setModelIoFullRetentionEnabled(enabled),

    readToolResultArtifact: (uri) =>
      artifactStore.readToolResultArtifact({ uri, trace: traceContext }),
    ...createAppAttachmentSurface(input),

    ...sessionFacade,

    close: async () => {
      try {
        await closeSession?.();
      } finally {
        try {
          providerModelRuntime?.dispose();
        } finally {
          await modelTelemetry.shutdown();
        }
      }
    },

    ...workflowFacade,

    ...scriptWorkflowFacade,
    ...createAppWorkflowSurface(input),

    ...createPluginFacadeForApp({ configResult, options, workingDirectory }),

    getPluginReferenceCatalog: readPluginReferenceCatalog,

    getSkillCatalog: async () => {
      // Skill 目录属于 context 初始化结果。冷恢复必须先恢复 Session 边界，再读取
      // 新 runtime 的快照，不能绕开 resume 后用旧工作目录独立扫描。
      await prepareUserExecutionBoundary({ traceContext });
      return await getRuntime().getSkillCatalog(traceContext);
    },

    resume: resumeFromStore,

    ...inputFacade,
  };
}
