/** SDK 对象仅作弱引用：代际元数据不能混入遥测正文。 */
export function createArmsTelemetryConsent(now: () => number = Date.now) {
  let allowed = false;
  let epoch = 0;
  let enabledAt = Infinity;
  const eventEpochs = new WeakMap<object, number>();
  const batchEpochs = new WeakMap<object, number>();
  return {
    isAllowed: () => allowed,
    setAllowed(next: boolean): void {
      if (allowed === next) return;
      allowed = next;
      epoch += 1;
      enabledAt = next ? now() : Infinity;
    },
    captureEvent(event: object): boolean {
      if (!allowed) return false;
      // Renderer IPC 或 crash collector 可能晚送旧事件；不能在重新允许时补传。
      const timestamp = (event as { timestamp?: unknown }).timestamp;
      if (typeof timestamp === "number" && timestamp < enabledAt) return false;
      eventEpochs.set(event, epoch);
      return true;
    },
    filterEvents<T extends object>(events: T[]): T[] {
      return allowed ? events.filter((event) => eventEpochs.get(event) === epoch) : [];
    },
    acceptBatch(bundle: object): boolean {
      if (!batchEpochs.has(bundle)) batchEpochs.set(bundle, epoch);
      return allowed && batchEpochs.get(bundle) === epoch;
    },
  };
}
