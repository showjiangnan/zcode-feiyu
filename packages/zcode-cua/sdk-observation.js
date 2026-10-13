// Modified by ZCode Feiyu.
/** 派生视图不授予权限；所有动作仍携带最新原生 observationId。 */
export function hydrateObservation(state, previous) {
  if (!state?.observationId || Array.isArray(state.nodes) || !state.diff) return state;
  if (state.diff.baseRevision !== previous?.revision || !Array.isArray(previous?.nodes))
    throw Object.assign(
      new Error("Compact observation baseline is unavailable; read a full state"),
      { code: "observation_baseline_missing" },
    );
  const nodes = new Map(previous.nodes.map((node) => [node.path, node]));
  for (const path of state.diff.removed || []) nodes.delete(path);
  for (const node of state.diff.changed || []) nodes.set(node.path, node);
  // Agent 可访问完整派生树；序列化只发送增量，避免同一结果重复加入模型上下文。
  Object.defineProperty(state, "nodes", { value: [...nodes.values()], enumerable: false });
  return state;
}

export function actionEnvelope(result, state) {
  if (!result.state) return result;
  result.state = state;
  // 兼容旧脚本的 result.image 等观察属性；执行事实和 state 始终完整保留。
  for (const key of Object.keys(state))
    if (!(key in result))
      Object.defineProperty(result, key, { get: () => state[key], enumerable: false });
  return result;
}

export function observationRequest(options, previous) {
  const targeted = options.elementId !== undefined || options.childOffset !== undefined;
  const diff = !targeted && options.disableDiff !== true && options.diff !== false;
  return {
    ...options,
    ...(diff
      ? {
          diff: true,
          compact: options.compact !== false,
          ...(options.baselineRevision === undefined &&
          previous?.revision &&
          !previous.scope?.rootPath
            ? { baselineRevision: previous.revision }
            : {}),
        }
      : {}),
  };
}
