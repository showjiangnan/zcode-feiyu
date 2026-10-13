// Modified by ZCode Feiyu.
import { CuaError, contextKey, LIMITS } from "../domain/protocol.js";
export function updateControlSource(owner, context, app, state, input) {
  if (typeof state.targetId !== "string" || !state.targetId)
    throw new CuaError("invalid_native_response", "Native target identity is missing");
  const id = `${contextKey(context)}\0${state.targetId}`;
  if (!owner.sources.has(id) && owner.sources.size >= LIMITS.sources)
    throw new CuaError("source_limit", "Close unused control sources before adding more");
  const previous = owner.sources.get(id);
  const source = {
    ...previous,
    id,
    context,
    sessionId: context.sessionId,
    turnId: context.turnId,
    workspaceKey: context.workspaceKey,
    app,
    title: state.title || "",
    targetId: state.targetId,
    windowId: state.windowId,
    input: {
      ...input,
      appId: app.appId,
      pid: state.pid,
      windowId: state.windowId,
      targetId: state.targetId,
    },
    phase: owner.paused.has(contextKey(context))
      ? "paused"
      : state.observationId
        ? "observing"
        : "ready",
    nativeGeneration: owner.native.generation,
    image: owner.visible.has(id) ? state.image : undefined,
    imageRevision:
      owner.visible.has(id) && state.image?.data && state.image.data !== previous?.image?.data
        ? (previous?.imageRevision || 0) + 1
        : previous?.imageRevision,
    frameReceivedAt:
      owner.visible.has(id) && state.image ? owner.ports.now() : previous?.frameReceivedAt,
    capturedAt: state.capturedAt,
    channels: state.channels,
    live: false,
  };
  owner.sources.set(id, source);
  owner.changed();
}
export function acceptControlFrame(owner, id, state, generation, expectedSource) {
  const source = owner.sources.get(id);
  if (
    !source ||
    (expectedSource && source !== expectedSource) ||
    owner.native.generation !== generation ||
    source.nativeGeneration !== generation ||
    owner.stopped.has(contextKey(source.context)) ||
    !owner.visible.has(id)
  )
    return;
  const sameFrame =
    source.image?.data &&
    source.image.data === state.image?.data &&
    source.image.mimeType === state.image.mimeType &&
    source.image.width === state.image.width &&
    source.image.height === state.image.height;
  source.frameSequence = (source.frameSequence || 0) + 1;
  if (!sameFrame) source.imageRevision = (source.imageRevision || 0) + 1;
  source.image = sameFrame ? source.image : state.image;
  source.frameReceivedAt = owner.ports.now();
  source.capturedAt = state.capturedAt;
  source.channels = state.channels;
  source.phase = owner.paused.has(contextKey(source.context))
    ? "paused"
    : source.reason === "device_busy"
      ? "busy"
      : state.image
        ? "observing"
        : "unavailable";
  source.live = Boolean(state.image);
  owner.changed();
}

export async function checkControlSource(owner, source) {
  const generation = owner.native.generation;
  const current = () =>
    !owner.closed &&
    owner.native.generation === generation &&
    source.nativeGeneration === generation &&
    owner.sources.get(source.id) === source;
  if (!current()) return;
  const params = { input: source.input, context: source.context, approved: true };
  const status = await owner.native.call("target_status", params, { timeoutMs: 5000 });
  if (!current() || status.targetId !== source.targetId || status.status !== "closed") return;
  // 捕获失败不能证明窗口关闭；只有原生精确身份确认消失并释放成功，才删除来源。
  const cleanup = await owner.native.call("close_target", params, { timeoutMs: 5000 });
  if (!current()) return;
  if (cleanup.status !== "closed")
    throw new CuaError("close_unconfirmed", "Closed target cleanup was not confirmed");
  owner.sources.delete(source.id);
  owner.visible.delete(source.id);
  for (const [subscriber, ids] of owner.subscriptions) {
    const remaining = ids.filter((id) => id !== source.id);
    if (remaining.length) owner.subscriptions.set(subscriber, remaining);
    else owner.subscriptions.delete(subscriber);
  }
  owner.changed();
}
