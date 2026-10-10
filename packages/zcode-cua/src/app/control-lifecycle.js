// Modified by ZCode Feiyu contributors (2026).
import { CuaError, contextKey, validateContext } from "../domain/protocol.js";
import { interruptionState } from "../domain/control-interruption.js";

export async function stopControl(owner, context, privacy = false, reason, origin) {
  const key = contextKey(validateContext(context));
  if (owner.stopping.has(key)) {
    if (privacy) owner.forgetSources(key, true);
    return owner.stopping.get(key);
  }
  const operation = confirmStop(owner, context, privacy, reason, origin);
  owner.stopping.set(key, operation);
  try {
    return await operation;
  } finally {
    owner.stopping.delete(key);
  }
}
async function confirmStop(owner, context, privacy, reason, origin) {
  const key = contextKey(context);
  if (
    owner.stopped.has(key) &&
    [...owner.sources.values()]
      .filter((source) => contextKey(source.context) === key)
      .every((source) => source.phase === "stopped")
  ) {
    if (privacy) owner.forgetSources(key, true);
    return;
  }
  // 重复确认仍保留第一次来源；同一个停止事实同时拥有 revision 和原因。
  const state =
    owner.stopped.get(key) ||
    interruptionState(
      owner.revision + 1,
      reason,
      owner.ports.now(),
      privacy ? "qualification-lost" : "trusted-ui-stop",
      origin,
    );
  if (!owner.stopped.has(key)) owner.ports.interrupted?.({ kind: "stopped", context, ...state });
  owner.stopped.set(key, state);
  const error = new CuaError(
    "turn_stopped",
    `Computer control stopped (${state.reason}); use the trusted Continue control action`,
    { reason: state.reason, origin: state.origin },
  );
  for (const operation of owner.operations.values())
    if (operation.key === key) operation.controller.abort(error);
  for (const [id, approval] of owner.approvals)
    if (contextKey(approval.context) === key) {
      owner.approvals.delete(id);
      approval.cleanup();
      approval.reject(error);
    }
  owner.forgetSources(key, privacy);
  for (const source of owner.sources.values())
    if (contextKey(source.context) === key) source.phase = "stopping";
  owner.changed();
  try {
    await owner.native.call("stop", { context });
    for (const source of owner.sources.values())
      if (contextKey(source.context) === key) source.phase = "stopped";
  } catch (error) {
    for (const source of owner.sources.values())
      if (contextKey(source.context) === key) {
        source.phase = "unknown";
        source.image = undefined;
      }
    await owner.native.close?.();
    throw error;
  } finally {
    owner.changed();
  }
}
export async function resumeControl(owner, context, revision) {
  const key = contextKey(validateContext(context));
  if (owner.stopping.has(key)) await owner.stopping.get(key);
  if (
    owner.ended.has(`${context.workspaceKey}\0${context.sessionId}\0${context.turnId}`) ||
    owner.ended.has(`${context.workspaceKey}\0${context.sessionId}\0*`)
  )
    throw new CuaError("turn_ended", "An ended task turn cannot be resumed");
  if ((owner.stopped.get(key) || owner.paused.get(key))?.revision !== revision)
    throw new CuaError("stale_resume", "Stop state changed; refresh before continuing");
  if (!(await owner.ports.enabled(context)))
    throw new CuaError("disabled", "Computer control is disabled");
  if (owner.ports.isTurnActive && !(await owner.ports.isTurnActive(context)))
    throw new CuaError("turn_ended", "The task runtime no longer owns this turn");
  await owner.native.call("resume", { context, approved: true });
  if (
    (owner.stopped.get(key) || owner.paused.get(key))?.revision !== revision ||
    (owner.ports.isTurnActive && !(await owner.ports.isTurnActive(context)))
  )
    throw new CuaError("stale_resume", "Control state changed while continuing");
  owner.stopped.delete(key);
  owner.paused.delete(key);
  for (const source of owner.sources.values())
    if (contextKey(source.context) === key) {
      source.phase = "ready";
      source.reason = undefined;
      source.live = false;
      source.image = undefined;
      source.nativeGeneration = owner.native.generation;
    }
  owner.changed();
}
export async function endControl(owner, event) {
  if (owner.ended.size >= 2048) {
    const oldest = owner.ended.values().next().value;
    owner.ended.delete(oldest);
  }
  owner.ended.add(
    `${event.workspaceKey || ""}\0${event.sessionId}\0${event.kind === "session-closed" ? "*" : event.turnId}`,
  );
  const contexts = new Map();
  for (const source of owner.sources.values())
    if (
      source.sessionId === event.sessionId &&
      (!event.workspaceKey || source.workspaceKey === event.workspaceKey) &&
      (!event.turnId || source.turnId === event.turnId)
    )
      contexts.set(contextKey(source.context), source.context);
  for (const approval of owner.approvals.values())
    if (
      approval.context.sessionId === event.sessionId &&
      (!event.workspaceKey || approval.context.workspaceKey === event.workspaceKey) &&
      (!event.turnId || approval.context.turnId === event.turnId)
    )
      contexts.set(contextKey(approval.context), approval.context);
  for (const operation of owner.operations.values())
    if (
      operation.context.sessionId === event.sessionId &&
      (!event.workspaceKey || operation.context.workspaceKey === event.workspaceKey) &&
      (!event.turnId || operation.context.turnId === event.turnId)
    )
      contexts.set(operation.key, operation.context);
  for (const grant of owner.grants.values())
    if (
      grant.context.sessionId === event.sessionId &&
      (!event.workspaceKey || grant.context.workspaceKey === event.workspaceKey) &&
      (!event.turnId || grant.context.turnId === event.turnId)
    )
      contexts.set(contextKey(grant.context), grant.context);
  for (const context of contexts.values()) {
    owner.ended.add(
      `${context.workspaceKey}\0${context.sessionId}\0${event.kind === "session-closed" ? "*" : context.turnId}`,
    );
    await owner.stop(context, true, "turn-ended");
    await owner.native.call("release", { context, ended: true });
  }
  for (const [id, source] of owner.sources)
    if (contexts.has(contextKey(source.context))) {
      owner.sources.delete(id);
      owner.visible.delete(id);
    }
  for (const [id, grant] of owner.grants)
    if (contexts.has(contextKey(grant.context))) owner.grants.delete(id);
  for (const key of contexts.keys()) {
    owner.stopped.delete(key);
    owner.paused.delete(key);
    for (const denied of owner.denied)
      if (denied.startsWith(`${key}\0`)) owner.denied.delete(denied);
  }
  owner.changed();
}
