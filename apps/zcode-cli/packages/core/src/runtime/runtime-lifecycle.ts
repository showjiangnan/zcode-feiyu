// Modified by ZCode Feiyu.
import { type OrchestrationMode, type OrchestrationState } from "@zcode/shared/zcode-protocol-v4";

import { withProjectMemoryWriteLease } from "../memory/write-lease.js";

import { disposeNodeReplSession } from "../tool/handlers/node-repl.js";

import type { SessionId } from "./deps.js";

import { recoverProjectMemoryWorkspace } from "./helpers/project-memory-batch.js";

import {
  runProjectMemoryReview,
  type ProjectMemoryReviewOutcome,
} from "./helpers/project-memory-review.js";
import { resolveEnabledProjectMemoryRoot } from "./helpers/project-memory.js";

import type { AgentRuntimeInternal } from "./internal.js";

import { dropRevokedMemoryFromTurnPrefix } from "./methods/context-refresh.js";
import { loadProjectMemoryIndexContent, loadProjectMemoryRoot } from "./methods/context.js";

import {
  assertProactiveAdmission,
  controlRuntimeProactiveWork,
  isProactiveCommandId,
  requestRuntimeOrchestrationMode,
} from "./orchestration.js";
import { runtimeProactiveCause } from "./proactive-causality.js";
import {
  getSuggestedPromptState,
  setSuggestedPromptEnabled,
  updateSuggestedPromptPreferences,
  invalidateSuggestedPrompt,
  settleSuggestedPrompt,
} from "./suggested-prompt/runtime.js";

export async function closeBrowserSession(this: AgentRuntimeInternal): Promise<void> {
  this.beginShutdown();
  await settleSuggestedPrompt(this);
  disposeNodeReplSession(this.sessionId);
  try {
    await this.browserControlPort?.closeSession?.({
      sessionId: this.sessionId,
      traceContext: this.rootTraceContext,
    });
  } catch (error) {
    // browser backend 清理失败不能阻断 execution/MCP/session store 的主关闭链路。
    this.logger?.warn("Browser session cleanup failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "browser.session_cleanup.failed",
    });
  }
}

export async function recoverProjectMemory(this: AgentRuntimeInternal): Promise<void> {
  await recoverProjectMemoryWorkspace(this as unknown as AgentRuntimeInternal);
}

export function beginShutdown(this: AgentRuntimeInternal): void {
  // ExecutionPort.close() 会把后台 Bash 收口为 cancelled；若允许
  // teardown terminal event 再唤醒模型，并与随后关闭的 session store 竞态。
  this.shuttingDown = true;
  invalidateSuggestedPrompt(this);
  // 关闭单个 session 后进程仍存活，
  // 因此必须先终止该 runtime 的 Extraction，不能只在超时后放弃等待。
  this.memoryExtractionScheduler?.shutdown();
  this.memoryRecoveryAbortController?.abort();
  this.memoryReviewAbortController?.abort();
}

export async function updateProjectMemoryPreferences(
  this: AgentRuntimeInternal,
  input: {
    policyRevision?: number;
    suggestedPrompt?: import("@zcode/shared").SuggestedPromptSettings;
    continuityPolicy?: import("@zcode/shared").ContinuityPolicy;
    enabled: boolean;
    extractionEnabled: boolean;
    reviewEnabled: boolean;
  },
): Promise<void> {
  const preferenceRevision = ++this.memoryPreferenceRevision;
  const memoryPermissionChanged = this.config.memory?.enabled !== input.enabled;
  const suggestedPromptToSettle = updateSuggestedPromptPreferences(this, input.suggestedPrompt);
  if (memoryPermissionChanged) invalidateSuggestedPrompt(this);
  const previousMemoryRoot =
    this.memoryRoot ?? resolveEnabledProjectMemoryRoot(this.config, this.workspaceRoot);
  if (input.continuityPolicy) this.config.continuityPolicy = input.continuityPolicy;
  if (input.policyRevision !== undefined)
    this.config.continuityPolicyRevision = input.policyRevision;
  if (
    input.continuityPolicy?.proactiveWorkAllowed === false &&
    ((this.orchestration.proactive && this.orchestration.proactive.status !== "stopped") ||
      this.proactiveWork)
  ) {
    await controlRuntimeProactiveWork(
      this as unknown as AgentRuntimeInternal,
      "pause",
      undefined,
      "permission_disabled",
    );
  }
  const extractionEnabled = input.enabled && input.extractionEnabled;
  const reviewEnabled = input.enabled && input.reviewEnabled;
  this.config.memory = {
    ...this.config.memory,
    enabled: input.enabled,
    extractionEnabled,
    reviewEnabled,
  };
  const recoveryToSettle = !extractionEnabled ? this.memoryRecoveryTask : undefined;
  if (!extractionEnabled) this.memoryRecoveryAbortController?.abort();
  const extractionToSettle = !extractionEnabled ? this.memoryExtractionScheduler : undefined;
  if (extractionToSettle) {
    extractionToSettle.shutdown();
    this.memoryExtractionScheduler = undefined;
  }
  const reviewToSettle =
    !input.enabled || (!reviewEnabled && this.memoryReviewTrigger === "automatic")
      ? this.memoryReviewTask
      : undefined;
  if (reviewToSettle || !input.enabled) {
    this.memoryReviewAbortController?.abort();
  }
  if (!input.enabled) {
    this.memoryRoot = undefined;
    this.memoryIndexContent = undefined;
    const runtime = this as unknown as AgentRuntimeInternal;
    dropRevokedMemoryFromTurnPrefix(runtime, this.messageHistory.borrowReadOnlyRuntimeEntries());
  }
  // 原因：旧实现仅发送 abort 就返回设置同步 ACK；旧 worker 仍可能在写文件。
  // 等原任务真实收口，协议若超时会报告未知/失败，不能提前宣称关闭已完成。
  const settling = await Promise.allSettled([
    suggestedPromptToSettle,
    ...(memoryPermissionChanged ? [settleSuggestedPrompt(this)] : []),
    ...(extractionToSettle ? [extractionToSettle.drain()] : []),
    ...(recoveryToSettle ? [recoveryToSettle] : []),
    ...(reviewToSettle ? [reviewToSettle.then(() => undefined)] : []),
  ]);
  const settlementFailures = settling.filter((result) => result.status === "rejected");
  if (settlementFailures.length > 0) {
    throw new AggregateError(
      settlementFailures.map((result) => result.reason),
      "Project memory workers failed while stopping",
    );
  }
  if (!input.enabled && previousMemoryRoot && this.sessionStore?.withProjectMemoryWriteFence) {
    // 等已进入最终提交的主线程记忆工具结束；旧调用在屏障内复核许可，ACK 后不会再迟到落盘。
    await withProjectMemoryWriteLease({
      sessionStore: this.sessionStore,
      workspaceKey: previousMemoryRoot,
      operation: (_signal, guard) => guard(async () => {}),
    });
  }
  if (!input.enabled || preferenceRevision !== this.memoryPreferenceRevision) {
    return;
  }
  if (!this.contextInitialized) return;
  const runtime = this as unknown as AgentRuntimeInternal;
  const root = await loadProjectMemoryRoot.call(runtime, this.rootTraceContext);
  if (preferenceRevision !== this.memoryPreferenceRevision || !this.config.memory.enabled) return;
  const indexContent = await loadProjectMemoryIndexContent(runtime, root, {
    recordReadState: false,
  });
  if (preferenceRevision !== this.memoryPreferenceRevision || !this.config.memory.enabled) return;
  this.memoryRoot = root;
  this.memoryIndexContent = indexContent;
}

export async function reviewProjectMemoryNow(
  this: AgentRuntimeInternal,
  sourceSessionId?: string,
): Promise<ProjectMemoryReviewOutcome> {
  return runProjectMemoryReview(this as unknown as AgentRuntimeInternal, {
    traceContext: this.rootTraceContext,
    trigger: "manual",
    sourceSessionId: sourceSessionId as SessionId | undefined,
  });
}

export function getOrchestrationState(this: AgentRuntimeInternal): OrchestrationState {
  return { ...this.orchestration };
}

export function getProactiveCausalContext(
  this: AgentRuntimeInternal,
): import("@zcode/shared/zcode-protocol-v4").ProactiveCausalContext | undefined {
  return runtimeProactiveCause(this as unknown as AgentRuntimeInternal);
}

export async function controlProactiveWork(
  this: AgentRuntimeInternal,
  action: "start" | "pause" | "stop",
  subscriptions?: import("@zcode/shared/zcode-protocol-v4").ProactiveSubscription[],
): Promise<OrchestrationState> {
  return controlRuntimeProactiveWork(
    this as unknown as AgentRuntimeInternal,
    action,
    subscriptions,
  );
}

export async function authorizeProactiveCommand(
  this: AgentRuntimeInternal,
  commandId: string,
): Promise<void> {
  if (isProactiveCommandId(commandId))
    await assertProactiveAdmission(this as unknown as AgentRuntimeInternal, commandId);
}

export async function requestOrchestrationMode(
  this: AgentRuntimeInternal,
  mode: OrchestrationMode,
): Promise<OrchestrationState> {
  return requestRuntimeOrchestrationMode(
    this as unknown as AgentRuntimeInternal,
    mode,
    this.rootTraceContext,
  );
}

export function cancelProjectMemoryReview(
  this: AgentRuntimeInternal,
  expectedReviewId?: string,
): boolean {
  const controller = this.memoryReviewAbortController;
  // 旧取消回执不能停止同一个 runtime 中已经接管的新整理。
  if (expectedReviewId !== undefined && this.memoryReviewId !== expectedReviewId) return false;
  if (!controller || controller.signal.aborted) return false;
  controller.abort();
  return true;
}

export function installRuntimeLifecycleMethods(ctor: { prototype: object }): void {
  const methods = {
    getSuggestedPromptState,
    setSuggestedPromptEnabled,
    closeBrowserSession,
    recoverProjectMemory,
    beginShutdown,
    updateProjectMemoryPreferences,
    reviewProjectMemoryNow,
    getOrchestrationState,
    getProactiveCausalContext,
    controlProactiveWork,
    authorizeProactiveCommand,
    requestOrchestrationMode,
    cancelProjectMemoryReview,
  };
  // 抽取前这些入口是 class 方法；显式描述符避免安装后变成可枚举属性。
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(ctor.prototype, name, {
      value: method,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}
