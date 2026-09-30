// Modified by ZCode Feiyu contributors (2026).
import {
  isTaskRoot,
  SessionEventType,
  type SessionEvent,
  type TurnInputIntentMetadata,
  type TurnStartedPayload,
  type TurnSteerDrainedPayload,
} from "@zcode/contracts";
import {
  proactiveCausalContextSchema,
  type ProactiveCausalContext,
} from "@zcode/shared/zcode-protocol-v4";
import type { AgentRuntimeInternal } from "./internal.js";

/** 因果只随实际消费的输入传递；任何时长窗口都会误伤独立输入或放过长任务。 */
export async function resolveProactiveInputCause(
  runtime: AgentRuntimeInternal,
  commandId: string | undefined,
  intent?: Pick<TurnInputIntentMetadata, "causalContext">,
  previous?: ProactiveCausalContext,
): Promise<ProactiveCausalContext | undefined> {
  if (!commandId) return previous;
  const incoming = proactiveCausalContextSchema.safeParse(intent?.causalContext);
  const trigger = await runtime.sessionStore?.readProactiveTrigger?.(commandId);
  if (trigger && trigger.targetSessionId !== runtime.sessionId)
    throw new Error("Proactive input belongs to another session");
  const persistedDepth = incoming.success
    ? incoming.data.depth
    : await runtime.sessionStore?.proactiveDepthForSource?.(runtime.sessionId, commandId);
  return {
    sourceCommandId: commandId,
    depth: Math.max(previous?.depth ?? 0, trigger?.depth ?? 0, persistedDepth ?? 0),
  };
}

/** 读取现有 active turn 的已消费上下文，发送端在异步路由前冻结这一份事实。 */
export function runtimeProactiveCause(
  runtime: AgentRuntimeInternal,
): ProactiveCausalContext | undefined {
  const cause = runtime.activeTurn?.causalContext;
  return cause ? { ...cause } : undefined;
}

export async function proactiveMailboxCause(
  runtime: AgentRuntimeInternal,
  message: import("@zcode/contracts").SessionMailboxEnvelope,
): Promise<ProactiveCausalContext | undefined> {
  if (!message.sourceCommandId) return;
  const source = await runtime.sessionStore?.getSession(message.fromSessionId);
  if (!source || (source.workspaceID?.trim() || source.directory) !== workspaceKey(runtime)) return;
  const depth = await runtime.sessionStore?.proactiveDepthForSource?.(
    message.fromSessionId,
    message.sourceCommandId,
  );
  return depth === null || depth === undefined
    ? undefined
    : { sourceCommandId: message.sourceCommandId, depth };
}

/** 即时 hook 上下文才合并到 active turn；PostToolUse 排队来源由原 input 在实际 drain 时合并。 */
export async function consumeProactiveMailboxCauses(
  runtime: AgentRuntimeInternal,
  messages: readonly import("@zcode/contracts").SessionMailboxEnvelope[],
): Promise<void> {
  const active = runtime.activeTurn;
  if (!active?.causalContext) return;
  for (const message of messages) {
    const cause = await proactiveMailboxCause(runtime, message);
    if (runtime.activeTurn !== active) return;
    if (cause) {
      active.causalContext = {
        ...active.causalContext,
        depth: Math.max(active.causalContext.depth, cause.depth),
      };
      await runtime.sessionStore?.mergeProactiveInputCause?.(
        runtime.sessionId,
        active.causalContext,
      );
    }
  }
}

export async function publishRuntimeProactiveEvent(
  runtime: AgentRuntimeInternal,
  event: SessionEvent,
): Promise<void> {
  const active = runtime.activeTurn;
  const ownsTurn = active && active.turnId === event.turnId;
  if (event.type === SessionEventType.TurnStarted) {
    const payload = event.payload as TurnStartedPayload;
    const cause = await resolveProactiveInputCause(
      runtime,
      payload.intent?.sourceCommandId ?? payload.inputId,
      payload.intent,
    );
    if (ownsTurn) active.causalContext = cause;
    if (
      isTaskRoot(runtime.config.taskType, runtime.config.parentSessionId) &&
      runtime.config.continuityPolicy?.proactiveWorkAllowed &&
      payload.automationId &&
      payload.inputId
    ) {
      await runtime.sessionStore?.publishProactiveEvent?.({
        eventId: `automation:${payload.inputId}`,
        workspaceKey: workspaceKey(runtime),
        sourceSessionId: runtime.sessionId,
        sourceId: payload.automationId,
        kind: "automation_due",
        depth: cause?.depth ?? 0,
        now: event.timestamp.getTime(),
        lifecycle: {
          eventId: String(event.id),
          type: event.type,
          turnId: event.turnId,
          commandId: payload.inputId,
        },
      });
    }
    return;
  }
  if (event.type === SessionEventType.TurnSteerDrained && ownsTurn) {
    for (const input of (event.payload as TurnSteerDrainedPayload).drainedInputs ?? []) {
      active.causalContext = await resolveProactiveInputCause(
        runtime,
        input.intent?.sourceCommandId ?? input.pendingInputId,
        input.intent,
        active.causalContext,
      );
    }
    return;
  }
  if (
    !isTaskRoot(runtime.config.taskType, runtime.config.parentSessionId) ||
    !runtime.config.continuityPolicy?.proactiveWorkAllowed
  )
    return;
  if (event.type !== SessionEventType.TurnComplete && event.type !== SessionEventType.TurnError)
    return;
  const payload = event.payload as { inputId?: string; resultType?: string };
  // 用户取消/暂停不是成功完成，不能由收口事件再次唤醒订阅者。
  if (payload.resultType === "cancelled") return;
  const persistedCause = proactiveCausalContextSchema.safeParse(
    (event.payload as { causalContext?: unknown }).causalContext,
  );
  const cause = persistedCause.success
    ? persistedCause.data
    : ownsTurn
      ? active.causalContext
      : await resolveProactiveInputCause(runtime, payload.inputId);
  // 无输入锚点的迟到/恢复事件不能借用另一轮 activeTurn 的深度。
  if (!cause) return;
  await runtime.sessionStore?.publishProactiveEvent?.({
    eventId: String(event.id),
    workspaceKey: workspaceKey(runtime),
    sourceSessionId: runtime.sessionId,
    sourceId: runtime.sessionId,
    kind: event.type === SessionEventType.TurnComplete ? "task_completed" : "task_failed",
    depth: cause.depth,
    now: event.timestamp.getTime(),
    lifecycle: {
      eventId: String(event.id),
      type: event.type,
      turnId: event.turnId,
      commandId: cause.sourceCommandId,
    },
  });
}

function workspaceKey(runtime: AgentRuntimeInternal): string {
  return (
    runtime.config.workspaceIdentity?.trim() ||
    runtime.config.memory?.workspaceIdentity?.trim() ||
    runtime.config.workspacePath ||
    runtime.workspaceRoot
  );
}
