// Modified by ZCode Feiyu contributors (2026).
import {
  DEFAULT_ORCHESTRATION_STATE,
  orchestrationStateSchema,
  resumeRetiredExecutionPause,
  type OrchestrationState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  SESSION_ENTRY_ORCHESTRATION_STATE,
  SessionEventType,
  type SessionEntryInfo,
  type TraceContext,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";
export function queueOrchestrationMutation<T>(
  runtime: AgentRuntimeInternal,
  operation: () => Promise<T>,
): Promise<T> {
  const task = (runtime.orchestrationMutation ?? Promise.resolve()).then(operation);
  runtime.orchestrationMutation = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

/**
 * running 的细分事实（复审 GAP-04）：runtime 持有主动轮次的取消目标即表示确有工作在跑；
 * 订阅就绪但没有在跑轮次是 sleeping。停止或暂停不携带该字段，避免把非运行状态解释成休眠。
 */
function withProactiveRuntimeState(
  runtime: AgentRuntimeInternal,
  state: OrchestrationState,
): OrchestrationState {
  const proactive = state.proactive;
  if (!proactive || proactive.status !== "running") return state;
  return {
    ...state,
    proactive: { ...proactive, runtimeState: runtime.proactiveWork ? "working" : "sleeping" },
  };
}

export async function restoreRuntimeOrchestrationMode(
  runtime: AgentRuntimeInternal,
): Promise<void> {
  if (!runtime.sessionStore?.sessionEntries) return;
  const entries = await runtime.sessionStore?.sessionEntries?.({
    sessionID: runtime.sessionId,
    type: SESSION_ENTRY_ORCHESTRATION_STATE,
  });
  const parsed = orchestrationStateSchema.safeParse(entries?.at(-1)?.data);
  runtime.orchestration = parsed.success ? parsed.data : { ...DEFAULT_ORCHESTRATION_STATE };
  runtime.orchestrationPersistedRevision = parsed.success ? parsed.data.revision : 0;
  // 旧预算暂停会让订阅永久沉默；仅在当前许可有效时沿原持久路径升级，旧代输入不复活。
  const next = resumeRetiredExecutionPause(
    runtime.orchestration,
    runtime.config.continuityPolicy?.proactiveWorkAllowed === true,
  );
  if (next !== runtime.orchestration) {
    await publishOrchestrationState(runtime, next, runtime.rootTraceContext);
    await runtime.sessionStore.rejectSupersededProactiveTriggers?.(
      runtime.sessionId,
      next.proactive!.generation,
      "retired_execution_limit",
      Date.now(),
    );
  }
}

export async function publishOrchestrationState(
  runtime: AgentRuntimeInternal,
  next: OrchestrationState,
  traceContext: TraceContext,
): Promise<void> {
  await persistOrchestrationState(runtime, next);
  runtime.orchestration = next;
  // 发布时带上 running 的细分（复审 GAP-04）：有主动轮次在跑就是 working，否则是 sleeping。
  // 事实来源是 runtime 自己持有的取消目标，不从订阅存在与否推断。
  const observed = withProactiveRuntimeState(runtime, next);
  await runtime.appendEvent(
    runtime.createEvent(SessionEventType.SessionOrchestrationChanged, observed, traceContext),
    traceContext,
  );
}

/**
 * 会话首次持久化时补写当前编排状态。
 *
 * 修复原因：预热会话上的模式请求在会话尚未持久化时被确认，`persistOrchestrationState` 因此静默跳过，
 * 而首次会话持久化只写模型选择、shell 快照与执行状态，不补编排状态；首个模型边界之前取消或崩溃，
 * 重启后已确认的模式会回到 standard（复审 DEF-15）。
 * 依据：CONT-FR-12 要求已确认的模式在会话恢复后保持一致；模式从未变更（修订仍为 0）时不写冗余条目。
 */
export async function persistRuntimeOrchestrationState(
  runtime: AgentRuntimeInternal,
): Promise<void> {
  await persistOrchestrationState(runtime, runtime.orchestration);
}

export async function persistOrchestrationState(
  runtime: AgentRuntimeInternal,
  state: OrchestrationState,
): Promise<void> {
  if (!runtime.sessionPersisted || state.revision <= runtime.orchestrationPersistedRevision) return;
  const store = runtime.sessionStore;
  if (!store?.saveSessionEntry) throw new Error("Orchestration persistence is unavailable");
  const now = Date.now();
  const entry: SessionEntryInfo = {
    id: `${runtime.sessionId}:runtime-orchestration-state`,
    sessionID: runtime.sessionId,
    type: SESSION_ENTRY_ORCHESTRATION_STATE,
    touchSession: false,
    time: { created: now, updated: now },
    data: state,
  };
  await store.saveSessionEntry(entry);
  runtime.orchestrationPersistedRevision = state.revision;
}
