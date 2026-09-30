// Modified by ZCode Feiyu contributors (2026).
import {
  queueOrchestrationMutation,
  restoreRuntimeOrchestrationMode,
  publishOrchestrationState,
  persistOrchestrationState,
} from "./orchestration-persistence.js";
export {
  restoreRuntimeOrchestrationMode,
  persistRuntimeOrchestrationState,
} from "./orchestration-persistence.js";
import {
  orchestrationStateSchema,
  type OrchestrationMode,
  type OrchestrationState,
  DEFAULT_PROACTIVE_STATE,
  proactiveSubscriptionSchema,
  type ProactiveSubscription,
} from "@zcode/shared/zcode-protocol-v4";
import { SESSION_ENTRY_ORCHESTRATION_STATE, isTaskRoot, type TraceContext } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";
import { resolveContinuityPolicy } from "./helpers/continuity-policy.js";
import {
  activateRequestedOrchestrationMode,
  requestOrchestrationMode,
} from "./orchestration-state.js";

export async function requestRuntimeOrchestrationMode(
  runtime: AgentRuntimeInternal,
  mode: OrchestrationMode,
  traceContext: TraceContext,
): Promise<OrchestrationState> {
  return queueOrchestrationMutation(runtime, async () => {
    if (runtime.sessionPersisted) await restoreRuntimeOrchestrationMode(runtime);
    const next = requestOrchestrationMode(runtime.orchestration, mode, Boolean(runtime.activeTurn));
    if (next === runtime.orchestration) return next;
    await publishOrchestrationState(runtime, next, traceContext);
    return next;
  });
}

export async function controlRuntimeProactiveWork(
  runtime: AgentRuntimeInternal,
  action: "start" | "pause" | "stop",
  subscriptions?: ProactiveSubscription[],
  reason = "user_control",
): Promise<OrchestrationState> {
  const result = await queueOrchestrationMutation(runtime, async () => {
    if (!isTaskRoot(runtime.config.taskType, runtime.config.parentSessionId))
      throw new Error("Proactive work requires a top-level session");
    if (action === "start" && !runtime.config.continuityPolicy?.proactiveWorkAllowed)
      throw new Error("Proactive work is disabled in settings");
    if (action === "start" && subscriptions && subscriptions.length > 20)
      throw new Error("Proactive subscription limit exceeded");
    if (runtime.sessionPersisted) await restoreRuntimeOrchestrationMode(runtime);
    const current = runtime.orchestration.proactive ?? DEFAULT_PROACTIVE_STATE;
    const selected =
      subscriptions?.map((item) => proactiveSubscriptionSchema.parse(item)) ??
      current.subscriptions;
    if (new Set(selected.map((item) => item.id)).size !== selected.length)
      throw new Error("Subscription IDs must be unique");
    if (action === "start" && selected.length === 0)
      throw new Error("Add an explicit event subscription before starting");
    if (selected.some((item) => item.sourceId === runtime.sessionId))
      throw new Error("A session cannot subscribe to its own events");
    for (const subscription of action === "start" ? selected : []) {
      if (subscription.event === "automation_due") {
        const automations = await runtime.automationPort?.list();
        if (!automations?.some((item) => item.automationId === subscription.sourceId))
          throw new Error("Subscription automation is unavailable in this workspace");
        continue;
      }
      const source = await runtime.sessionStore?.getSession(
        subscription.sourceId as import("@zcode/contracts").SessionId,
      );
      if (
        !source ||
        !isTaskRoot(source.taskType, source.parentID) ||
        (source.workspaceID?.trim() || source.directory) !==
          (runtime.config.workspaceIdentity?.trim() ||
            runtime.config.memory?.workspaceIdentity?.trim() ||
            runtime.config.workspacePath ||
            runtime.workspaceRoot)
      )
        throw new Error("Subscription source must be a top-level task in this workspace");
    }
    await runtime.ensureSessionPersistedForExternalActivity("", {
      traceContext: runtime.rootTraceContext,
    });
    const status = action === "start" ? "running" : action === "pause" ? "paused" : "stopped";
    const unchanged = action !== "start" && current.status === status && current.reason === reason;
    const next: OrchestrationState = unchanged
      ? runtime.orchestration
      : {
          ...runtime.orchestration,
          revision: runtime.orchestration.revision + 1,
          proactive: {
            ...current,
            consecutiveTurns: current.consecutiveTurns,
            status,
            generation: current.generation + 1,
            subscriptions: selected,
            reason: action === "start" ? null : reason,
          },
        };
    // 取消目标必须在串行变更中冻结；await 后读取可能误取消新 generation 的执行。
    const work = runtime.proactiveWork;
    work?.controller.abort(new Error(`Proactive work ${action}: ${reason}`));
    // 另一 Host 可能已暂停同一持久事实，或上次在持久化后发布失败；相同 revision 也重发事实修复 live 投影。
    await publishOrchestrationState(runtime, next, runtime.rootTraceContext);
    await settleSupersededProactiveInputs(runtime, next.proactive!.generation, reason);
    return { state: next, work };
  });
  await result.work?.settled;
  return result.state;
}

async function settleSupersededProactiveInputs(
  runtime: AgentRuntimeInternal,
  generation: number,
  reason: string,
): Promise<void> {
  await runtime.sessionStore?.rejectSupersededProactiveTriggers?.(
    runtime.sessionId,
    generation,
    reason,
    Date.now(),
  );
  const inputs =
    (await runtime.sessionStore?.listSessionInputs?.({
      sessionID: runtime.sessionId,
      status: "admitted",
    })) ?? [];
  for (const input of inputs) {
    const intent = (input.payload.conversationInputIntent ?? input.payload.intent) as
      | { sourceCommandId?: string }
      | undefined;
    const commandId = intent?.sourceCommandId ?? input.id;
    if (!isProactiveCommandId(commandId)) continue;
    const trigger = await runtime.sessionStore?.readProactiveTrigger?.(commandId);
    if (
      !trigger ||
      trigger.targetSessionId !== runtime.sessionId ||
      trigger.generation >= generation
    )
      continue;
    // 复用既有 queue 删除与 discard 事件，不造第二条队列；已提升输入不会被终态回滚。
    await runtime.removePendingInputById({
      pendingInputId: input.id,
      reason: "user_removed",
      traceContext: runtime.rootTraceContext,
      reservationId: runtime.pendingInputReservations?.get(input.id),
    });
    await runtime.sessionStore?.settleSessionInput?.({
      id: input.id,
      sessionID: runtime.sessionId,
      status: "cancelled",
      reason,
    });
  }
}

export function isProactiveCommandId(commandId?: string): boolean {
  return Boolean(commandId?.startsWith("task-app:") && commandId.includes(":proactive:"));
}
async function assertProactiveState(
  runtime: AgentRuntimeInternal,
  commandId: string,
): Promise<void> {
  if (!resolveContinuityPolicy(runtime).policy?.proactiveWorkAllowed)
    throw new Error("Proactive work is disabled");
  const trigger = await runtime.sessionStore?.readProactiveTrigger?.(commandId);
  const entries = await runtime.sessionStore?.sessionEntries?.({
    sessionID: runtime.sessionId,
    type: SESSION_ENTRY_ORCHESTRATION_STATE,
  });
  const parsed = orchestrationStateSchema.safeParse(entries?.at(-1)?.data);
  const state = parsed.success ? parsed.data.proactive : undefined;
  if (
    !trigger ||
    trigger.state === "rejected" ||
    trigger.targetSessionId !== runtime.sessionId ||
    state?.status !== "running" ||
    state.generation !== trigger.generation
  )
    throw new Error("Proactive event was stopped or superseded");
  // sessionEntries 等待期间策略也可撤销，不能用 await 前的许可作为准入依据。
  if (!resolveContinuityPolicy(runtime).policy?.proactiveWorkAllowed)
    throw new Error("Proactive work is disabled");
}

/** 排队及发送边界复核当前主动许可与代次。 */
export async function assertProactiveExecution(
  runtime: AgentRuntimeInternal,
  commandId: string,
): Promise<void> {
  await assertProactiveState(runtime, commandId);
}

export async function assertProactiveAdmission(
  runtime: AgentRuntimeInternal,
  commandId: string,
): Promise<void> {
  await assertProactiveState(runtime, commandId);
}

export async function activateRuntimeOrchestrationMode(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<OrchestrationState> {
  return queueOrchestrationMutation(runtime, async () => {
    const next = activateRequestedOrchestrationMode(runtime.orchestration);
    if (next !== runtime.orchestration) {
      await publishOrchestrationState(runtime, next, traceContext);
    } else {
      await persistOrchestrationState(runtime, next);
    }
    return runtime.orchestration;
  });
}

/** 持久计数仅用于观察主动事件进展，不作为停止条件。 */
export async function admitConsecutiveProactiveTurn(
  runtime: AgentRuntimeInternal,
  commandId: string,
): Promise<void> {
  await assertProactiveAdmission(runtime, commandId);
  await runtime.ensureSessionPersistedForExternalActivity("", {
    traceContext: runtime.rootTraceContext,
  });
  await queueOrchestrationMutation(runtime, async () => {
    if (runtime.sessionPersisted) await restoreRuntimeOrchestrationMode(runtime);
    await assertProactiveState(runtime, commandId);
    const current = runtime.orchestration.proactive!;
    const count = current.consecutiveTurns ?? 0;
    const next: OrchestrationState = {
      ...runtime.orchestration,
      revision: runtime.orchestration.revision + 1,
      proactive: {
        ...current,
        consecutiveTurns: count + 1,
      },
    };
    await publishOrchestrationState(runtime, next, runtime.rootTraceContext);
  });
}

/** 可信用户输入仅重置观察计数，不恢复用户暂停或停止。 */
export async function resetProactiveForUserInput(runtime: AgentRuntimeInternal): Promise<void> {
  await queueOrchestrationMutation(runtime, async () => {
    if (runtime.sessionPersisted) await restoreRuntimeOrchestrationMode(runtime);
    const current = runtime.orchestration.proactive;
    if (!current) return;
    if (!(current.consecutiveTurns ?? 0)) return;
    const next: OrchestrationState = {
      ...runtime.orchestration,
      revision: runtime.orchestration.revision + 1,
      proactive: {
        ...current,
        consecutiveTurns: 0,
      },
    };
    await publishOrchestrationState(runtime, next, runtime.rootTraceContext);
  });
}
