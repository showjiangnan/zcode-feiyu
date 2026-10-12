// Modified by ZCode Feiyu.
import type { Logger, SessionId, SessionStorePort } from "@zcode/contracts";
import { resolveEffectiveBashShellSelection } from "@zcode/adapters/exec";

import { type ExecutionShellSelection, type TraceContext } from "@zcode/contracts";
import { AgentRuntime, type ResumeSessionResult } from "@zcode/core";

import { readSessionModelSelection } from "./session-store.js";

import type { PrepareUserExecutionBoundary, ResumeOptions, ZCodeAppOptions } from "./types.js";

// 装配阶段复用同一实例与闭包，不另建运行状态或副作用路径。
export function createAppResumeLifecycle(input: {
  options: ZCodeAppOptions;
  getRuntime: () => AgentRuntime;
  sessionStore: SessionStorePort;
  sessionId: SessionId;
  logger: Logger;
  traceContext: TraceContext;
  readComputerUseCapabilities: () => ((trace: TraceContext) => Promise<void>) | undefined;
}) {
  const {
    options,
    getRuntime,
    sessionStore,
    sessionId,
    logger,
    traceContext,
    readComputerUseCapabilities,
  } = input;

  let resumePrepared = false;

  const resolveDefaultShellSelection = (): ExecutionShellSelection =>
    resolveEffectiveBashShellSelection({
      env: options.env ?? process.env,
      platform: options.platform ?? process.platform,
    }).selection;

  let initialShellSelectionPromise: Promise<ExecutionShellSelection> | undefined;

  const resolveInitialShellSelection = (): Promise<ExecutionShellSelection> => {
    initialShellSelectionPromise ??= (async () =>
      (await options.resolveInitialBashShellSelection?.()) ?? resolveDefaultShellSelection())();
    return initialShellSelectionPromise;
  };

  const initializeSessionShellEnvironment = async (): Promise<void> => {
    getRuntime().initializeSessionShellEnvironmentIfNeeded(await resolveInitialShellSelection());
  };

  const restorePersistedModelSelection = async (): Promise<
    ResumeSessionResult["modelSelection"]
  > => {
    const registry = options.providerRegistry;
    let selection: ResumeSessionResult["modelSelection"];
    try {
      // 数据库启动已完成版本化迁移；恢复只读新字段，不按会话重复补迁。
      selection = await readSessionModelSelection(sessionStore, sessionId);
    } catch (error) {
      // 选择 entry 的读取/解析故障不能拖垮独立的历史恢复；留下真实存储错误，
      // 不读取旧消息或默认模型来掩盖失败。
      logger.warn("Session model selection restore failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "session.model_selection.restore_failed",
        sessionId,
      });
    }
    const validation = selection && registry.validateSelection(selection);
    if (selection && validation && !validation.ok) {
      // 观测：校验失败只影响运行绑定、不影响保存意图；但一旦不绑定，之后若只发送 execution 作用域的
      // 加速轮就没有机会重新绑定。曾在 Registry 刚就绪、账号权益未解析的 600ms 窗口内静默置空，
      // 直到加速卡过期降级找不到退回目标才暴露，日志里却看不到这一步。
      logger.warn("Session model selection restored but not bound to the runtime", {
        event: "session.model_selection.restore_unbound",
        modelId: selection.modelId,
        providerId: selection.providerId,
        sessionId,
        validationCode: validation.code,
      });
    }
    // 只查模型是否存在会把缺档位/已删除的选择重新绑定进 Runtime，
    // 抵消了未绑定初始化。历史恢复不要求可执行模型，只有完整选择可以绑定。
    getRuntime().setSessionModelSelection(validation?.ok ? selection : undefined);
    // 恢复结果是保存意图，不是执行绑定。过去在这里置空/删档位，Host 的
    // Selection View 就再也拿不到原意图，账号切换和配置恢复后也无法重新解析。
    return selection;
  };

  const resumeFromStore = async (resumeOptions?: ResumeOptions): Promise<ResumeSessionResult> => {
    const runtime = getRuntime();
    const unsubscribe = resumeOptions?.onEvent
      ? runtime.subscribeEvents({ onSessionEvent: resumeOptions.onEvent })
      : undefined;

    try {
      const resumeTraceContext = resumeOptions?.traceContext ?? traceContext;
      const modelSelection = await restorePersistedModelSelection();
      await initializeSessionShellEnvironment();
      const result = await runtime.resumeFromStore({
        ...(resumeOptions?.abortSignal ? { abortSignal: resumeOptions.abortSignal } : {}),
        // 只传调用方原始 mode；项目/全局默认值不能伪装成 invocation override，
        // 否则交互式 resume 将无法恢复真正持久化的 session mode。
        modeOverride: options.runtimeConfig?.mode,
        persistedMessages: resumeOptions?.persistedMessages,
        traceContext: resumeTraceContext,
      });
      await runtime.activatePausedTargetAfterResume(resumeTraceContext);
      resumePrepared = true;
      return { ...result, modelSelection };
    } finally {
      unsubscribe?.();
    }
  };

  const prepareResume = async (
    submitTraceContext?: TraceContext,
    abortSignal?: AbortSignal,
  ): Promise<void> => {
    if (!options.resume || resumePrepared) return;
    await resumeFromStore({
      ...(abortSignal ? { abortSignal } : {}),
      traceContext: submitTraceContext ?? traceContext,
    });
    resumePrepared = true;
  };

  const prepareUserExecutionBoundary: PrepareUserExecutionBoundary = async (boundaryOptions) => {
    // Bash shell 快照属于“首次真实用户执行”边界，而不是 chat
    // input 独有状态。普通 prompt、expert workflow、script workflow 都可能
    // 作为新 session 的第一个模型/子 agent 入口，必须统一在 resume/context
    // 初始化前落定一次，避免模型看到的 Shell 与 Bash 执行 shell 分叉。
    await initializeSessionShellEnvironment();
    await prepareResume(boundaryOptions?.traceContext, boundaryOptions?.abortSignal);
    await readComputerUseCapabilities()?.(boundaryOptions?.traceContext ?? traceContext);
  };
  return { prepareUserExecutionBoundary, prepareResume, resumeFromStore };
}
