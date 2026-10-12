// Modified by ZCode Feiyu.
import type { CreateSessionFacadeDeps, SessionFacade } from "./session-facade-types.js";
import { closeSessionResources } from "./session-resources.js";
export { closeSessionResources } from "./session-resources.js";
import { createSessionMcpFacade } from "./session-mcp-facade.js";
import { createSessionConfigurationFacade } from "./session-configuration-facade.js";
import { createSessionTargetFacade } from "./session-target-facade.js";

import { type MessageId } from "@zcode/contracts";

import { normalizeModelSelection } from "@zcode/provider";

import { loadSessionTranscriptFromStore } from "../session-transcript.js";

import { completeAuxiliaryRegistryModelSelection } from "./provider-registry-selection.js";
import { isClosableSessionStore } from "./session-store.js";
import { createSubagentObservation } from "./subagent-observation.js";

export function createSessionFacade(deps: CreateSessionFacadeDeps): SessionFacade {
  let closePromise: Promise<void> | undefined;
  return {
    ...createSessionMcpFacade(deps),
    ...createSessionConfigurationFacade(deps),
    ...createSessionTargetFacade(deps),

    close: async () => {
      closePromise ??= (async () => {
        // 关闭入口先阻止新调度并取消在飞 Memory Extraction，再等待取消链路收口。
        deps.runtime.beginShutdown();
        await deps.runtime.drainMemoryExtractions(60_000);
        // 引擎归本 App 所有，所以关闭要主动停下它。
        // 位置是两个约束夹出来的：在 beginShutdown **之后**，结算带出的终态通知才会被丢掉
        // （background-notifications.ts 在 shuttingDown 时不入队），不会把正在关闭的会话的模型
        // 叫醒；在 closeSessionResources **之前**，子代理还有 execution / MCP / session store
        // 可以干净地中止，引擎也还有 journal 可以写自己那一笔 stopped(interrupted)。
        if (deps.closeDynamicWorkflowRuns !== undefined) {
          try {
            await deps.closeDynamicWorkflowRuns();
          } catch (error: unknown) {
            // 卡住或抛错的 dwf 关闭绝不能吃掉资源关闭（同下面并行关闭那条注释的论证）：
            // 记一条 warn 继续走，最坏情况是那个 run 留成孤儿行，下一次构造时被收敛。
            deps.logger.warn?.(
              "Closing dynamic workflow runs failed; continuing to close resources",
              {
                errorMessage: error instanceof Error ? error.message : String(error),
                event: "dynamic_workflow.service.close_failed",
                module: "bootstrap.app",
              },
            );
          }
        }
        const closableSessionStore =
          deps.ownsSessionStore && isClosableSessionStore(deps.sessionStore)
            ? deps.sessionStore
            : undefined;
        await closeSessionResources({
          beginShutdown: () => deps.runtime.beginShutdown(),
          closeBrowserSession: () => deps.runtime.closeBrowserSession(),
          closeExecution:
            deps.ownsExecutionPort && deps.executionPort.close
              ? () => deps.executionPort.close?.()
              : undefined,
          closeMcp: deps.ownsMcpPort && deps.mcpPort ? () => deps.mcpPort?.close() : undefined,
          closeNodeReplBrowserBroker: deps.closeNodeReplBrowserBroker,
          closeSessionStore: closableSessionStore ? () => closableSessionStore.close() : undefined,
          logger: deps.logger,
        });
      })();
      return await closePromise;
    },

    loadSessionTranscript: async () =>
      await loadSessionTranscriptFromStore({
        sessionId: deps.sessionId,
        sessionStore: deps.sessionStore,
      }),

    ...createSubagentObservation(deps),

    readTodos: async () => deps.sessionStore.readTodos({ sessionID: deps.sessionId }),

    setCustomSessionTitle: async (input) =>
      deps.runtime.setCustomSessionTitle({
        title: input.title,
        traceContext: input.traceContext ?? deps.traceContext,
      }),

    readBackgroundBashOutput: (workId, sessionId) =>
      deps.runtime.readBackgroundBashOutput(workId, sessionId),

    cancelBackgroundTask: async (taskId, options) =>
      deps.runtime.cancelBackgroundTask(taskId, {
        traceContext: options?.traceContext ?? deps.traceContext,
      }),

    listCheckpoints: async (options) => {
      await deps.prepareResume();
      return deps.runtime.listWorkspaceCheckpoints(options);
    },

    forkFromCheckpoint: async (options) => {
      await deps.prepareResume(options?.traceContext);
      return deps.runtime.forkWorkspaceFromCheckpoint({
        targetCheckpointId: options?.targetCheckpointId,
        targetMessageId: options?.targetMessageId as MessageId | undefined,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },

    sampleModel: (input, options) =>
      deps.runtime.sampleModel(input, {
        ...options,
        traceContext: options.traceContext ?? deps.traceContext,
      }),

    generateWorkspaceText: async (input, options) => {
      // 辅助文本入口只规范化模型身份；具体的最低档位由 Core 的辅助请求调用点显式决定。
      const selection =
        normalizeModelSelection(deps.providerRegistry.getView(), input.selection) ??
        input.selection;
      return await deps.runtime.generateWorkspaceText(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },

    testModelConnectivity: async (input, options) => {
      // 连接测试用的 Model 也要先绑定最低档位，否则严格 Factory 会先因缺档位失败。
      const selection = completeAuxiliaryRegistryModelSelection(
        deps.providerRegistry,
        input.selection,
      );
      await deps.runtime.testModelConnectivity(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },
  };
}
