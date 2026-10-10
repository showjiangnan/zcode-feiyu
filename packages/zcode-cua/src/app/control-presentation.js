// Modified by ZCode Feiyu contributors (2026).
import { CuaError, contextKey, LIMITS } from "../domain/protocol.js";

export function setControlVisibility(owner, ids, subscriber = "default") {
  if (owner.subscriptions.size >= 32 && !owner.subscriptions.has(subscriber))
    throw new CuaError("busy", "Too many preview subscribers");
  if (ids.length) owner.subscriptions.set(subscriber, ids);
  else owner.subscriptions.delete(subscriber);
  owner.visible = new Set(
    [...owner.subscriptions.values()]
      .flat()
      .filter((id) => owner.sources.has(id))
      .slice(0, LIMITS.visibleSources),
  );
  for (const source of owner.sources.values())
    if (!owner.visible.has(source.id)) {
      source.live = false;
      source.image = undefined;
    }
  owner.changed();
}
export function controlSnapshot(owner, workspaceKey) {
  const permitted = (context) => !workspaceKey || context.workspaceKey === workspaceKey;
  return {
    schemaVersion: 1,
    generation: owner.native.generation,
    revision: owner.revision,
    sources: [...owner.sources.values()]
      .filter((s) => permitted(s.context))
      .map(({ input: _input, context, ...s }) => ({
        ...s,
        context,
        stopRevision: (
          owner.stopped.get(contextKey(context)) || owner.paused.get(contextKey(context))
        )?.revision,
        stopOrigin: (
          owner.stopped.get(contextKey(context)) || owner.paused.get(contextKey(context))
        )?.origin,
        reason:
          (owner.stopped.get(contextKey(context)) || owner.paused.get(contextKey(context)))
            ?.reason || s.reason,
      })),
    approvals: [...owner.approvals.values()]
      .filter((a) => permitted(a.context))
      .map((a) => ({ id: a.id, context: a.context, app: a.app, createdAt: a.createdAt })),
  };
}
export function markFrameUnavailable(owner, id, reason) {
  const source = owner.sources.get(id);
  if (source) {
    source.live = false;
    source.image = undefined;
    source.phase = "unavailable";
    source.reason = reason;
    owner.changed();
  }
}
export function visibleControlSources(owner) {
  return [...owner.sources.values()].filter(
    (s) =>
      owner.visible.has(s.id) &&
      !owner.stopped.has(contextKey(s.context)) &&
      s.nativeGeneration === owner.native.generation,
  );
}
