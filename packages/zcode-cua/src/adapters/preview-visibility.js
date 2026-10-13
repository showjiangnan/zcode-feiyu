// Modified by ZCode Feiyu.
// 合并展示投影，始终读取 Coordinator 当前事实；这里不接受或保存 Agent 输入。
export function createPreviewVisibilitySynchronizer({ getNative, getProjection, onError }) {
  let pending;
  async function synchronize() {
    let delivered;
    let native;
    try {
      for (;;) {
        native = getNative();
        if (!native?.child || native.disposed) return;
        const projection = getProjection();
        const identity = JSON.stringify([native.generation, projection.sources]);
        if (identity === delivered) return;
        await native.call("preview_visibility", projection);
        delivered = identity;
      }
    } catch (error) {
      await onError(error, native);
    }
  }
  return {
    sync() {
      if (pending) return pending;
      pending = synchronize().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}
