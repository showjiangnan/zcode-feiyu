// Modified by ZCode Feiyu contributors (2026).
/** 事件驱动的有界观察；订阅先于读取，dirty 水位防止异步读取期间丢掉终态事件。 */
export function waitForTaskObservation<T>(options: {
  read(): Promise<T>;
  subscribe(wake: () => void): { dispose(): void };
  ready(value: T): "changed" | "terminal" | "needs_input" | undefined;
  timeoutMs: number;
  signal?: AbortSignal;
  /** 期限到达时尚无任何观察值所用的错误；缺省为普通 Error。调用方据此映射成自己的错误码。 */
  deadlineError?: () => unknown;
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
        // 修复原因：期限到达时若读取仍在途，旧实现继续等待它返回，慢读取或挂起的读取会让有界等待失去边界（复审 DEF-19）。
        // 依据：等待的合同是在期限内返回最近一次观察值；已有观察值就直接返回，在途读取的迟到结果由 finished 标记丢弃。
        // 尚无任何观察值时无从返回，按调用方约定的错误失败，不能无限挂起。
        if (hasCurrent) finish(current, "timeout");
        else
          fail(
            options.deadlineError?.() ??
              new Error("Task observation deadline elapsed before the first read"),
          );
      }, options.timeoutMs);
    void read();
  });
}
