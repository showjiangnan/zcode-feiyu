// Modified by ZCode Feiyu.
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
      const elapsed = Math.max(0, now() - started);
      // 慢捕获已降帧，仍需留出恢复空隙；完成后立即重采会让繁忙后端持续满负荷。
      const activeDelay = elapsed < 400 ? Math.max(0, 200 - elapsed) : Math.min(1000, elapsed / 4);
      if (!disposed) schedule(hasActivity() ? activeDelay : 1000);
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
