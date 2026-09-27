/** 事件驱动的有界观察；订阅先于读取，dirty 水位防止异步读取期间丢掉终态事件。 */
export function waitForTaskObservation<T>(options: {
  read(): Promise<T>;
  subscribe(wake: () => void): { dispose(): void };
  ready(value: T): "changed" | "terminal" | "needs_input" | undefined;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ value: T; reason: "changed" | "terminal" | "needs_input" | "timeout" }> {
  return new Promise((resolve, reject) => {
    let finished = false,
      reading = false,
      dirty = true,
      expired = options.timeoutMs === 0;
    let current: T;
    let hasCurrent = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: { dispose(): void } | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      observer?.dispose();
      options.signal?.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };
    const finish = (value: T, reason: "changed" | "terminal" | "needs_input" | "timeout") => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve({ value, reason });
    };
    const abort = () =>
      fail(
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new DOMException("Task observation cancelled", "AbortError"),
      );
    const read = async () => {
      if (reading || finished) return;
      reading = true;
      try {
        while (dirty && !finished) {
          dirty = false;
          current = await options.read();
          hasCurrent = true;
          if (finished) return;
          const reason = options.ready(current);
          if (reason) {
            finish(current, reason);
            return;
          }
          if (expired) {
            finish(current, "timeout");
            return;
          }
        }
      } catch (error) {
        fail(error);
      } finally {
        reading = false;
      }
    };
    const wake = () => {
      dirty = true;
      void read();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    try {
      observer = options.subscribe(wake);
    } catch (error) {
      fail(error);
      return;
    }
    if (finished) {
      observer.dispose();
      return;
    }
    if (!expired)
      timer = setTimeout(() => {
        expired = true;
        if (hasCurrent && !reading) finish(current, "timeout");
      }, options.timeoutMs);
    void read();
  });
}
