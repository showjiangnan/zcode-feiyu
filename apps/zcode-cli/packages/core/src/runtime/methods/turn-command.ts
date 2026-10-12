// Modified by ZCode Feiyu.
import {
  isProactiveCommandId,
  admitConsecutiveProactiveTurn,
  resetProactiveForUserInput,
} from "../orchestration.js";
import { isTrustedUserInput } from "../trusted-user-input.js";

import { createTurnId } from "../deps.js";
import type { TurnState } from "../deps.js";
import type { ExecuteTurnOptions, TurnResult } from "../types.js";
import type { ActiveTurnStartReservation } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { PromptRuntimeCommand } from "../command-queue.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";

import {
  continuityBackgroundWorkTitle,
  settleContinuityBackgroundWork,
  startContinuityBackgroundWork,
} from "../helpers/continuity-background-work.js";

import { executeTurnCommandOwned } from "./turn-owned-execution.js";
export async function executeTurn(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
): Promise<TurnResult> {
  return await enqueueCancellableRuntimeCommand<TurnResult, PromptRuntimeCommand>(this, {
    abortSignal: options?.abortSignal,
    createCommand: ({ reject, resolve }) => ({
      attachments,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      input,
      mode: "prompt",
      options,
      priority: "next",
      reject,
      resolve,
      traceContext: options?.traceContext ?? this.rootTraceContext,
    }),
  });
}
export async function executeTurnCommand(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
  startReservation?: ActiveTurnStartReservation,
): Promise<TurnResult> {
  const commandId = options?.intent?.sourceCommandId ?? options?.inputId;
  if (!isProactiveCommandId(commandId)) {
    if (isTrustedUserInput(this, options)) await resetProactiveForUserInput(this);
    return executeTurnCommandOwned.call(this, input, attachments, options, startReservation);
  }
  const controller = new AbortController();
  let finish!: () => void;
  const work = {
    controller,
    settled: new Promise<void>((resolve) => {
      finish = resolve;
    }),
  };
  // 先登记取消目标再等待持久校验，消除“暂停已 ACK，旧代才开始执行”的异步空窗。
  this.proactiveWork = work;
  // 抽屉条目（复审 GAP-03）：workId 绑定这次触发，与 runtime.proactiveWork 同一份事实——不新建状态。
  // 只在准入通过、确实要跑模型之后才开始，避免把「被拒绝的主动事件」显示成正在工作。
  const workId = `${this.sessionId}:proactive:${commandId ?? createTurnId()}`;
  const workTitle = () =>
    continuityBackgroundWorkTitle({ kind: "proactive", language: this.config.language });
  let workStarted = false;
  try {
    try {
      await admitConsecutiveProactiveTurn(this, commandId!);
      controller.signal.throwIfAborted();
    } catch (error) {
      if (startReservation) this.releaseTurnStart(startReservation.turnId);
      throw error;
    }
    await startContinuityBackgroundWork(
      this,
      { kind: "proactive", title: workTitle(), workId },
      options?.traceContext ?? this.rootTraceContext,
    );
    workStarted = true;
    return await executeTurnCommandOwned.call(
      this,
      input,
      attachments,
      {
        ...options,
        abortSignal: options?.abortSignal
          ? AbortSignal.any([options.abortSignal, controller.signal])
          : controller.signal,
      },
      startReservation,
    );
  } finally {
    finish();
    if (this.proactiveWork === work) this.proactiveWork = undefined;
    if (workStarted) {
      // 取消与失败分开：停止入口/预算/轮次上限都中止 controller，那是取消，不是故障。
      await settleContinuityBackgroundWork(
        this,
        {
          kind: "proactive",
          status: controller.signal.aborted ? "cancelled" : "completed",
          title: workTitle(),
          workId,
        },
        options?.traceContext ?? this.rootTraceContext,
      );
    }
  }
}
