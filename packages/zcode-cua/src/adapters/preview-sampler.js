// Modified by ZCode Feiyu contributors (2026).
// 新来源变为可见时立即唤醒空闲采样；逐帧投影不唤醒，避免形成无界循环。
export function createPreviewSampler({
  sample,
  hasActivity,
  onError,
  now = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer;
  let running = false;
  let disposed = false;
  const schedule = (delay) => {
    clearTimer(timer);
    timer = setTimer(() => void run(), delay);
    timer?.unref?.();
  };
  const run = async () => {
    if (disposed || running) return;
    clearTimer(timer);
    timer = undefined;
    running = true;
    const started = now();
    try {
      await sample();
    } catch (error) {
      onError?.(error);
    } finally {
      running = false;
      if (!disposed) schedule(hasActivity() ? Math.max(0, 200 - (now() - started)) : 1000);
    }
  };
  return {
    wake() {
      if (!disposed && !running) schedule(0);
    },
    stop() {
      disposed = true;
      clearTimer(timer);
      timer = undefined;
    },
  };
}
