// Modified by ZCode Feiyu contributors (2026).
/** 进程内只读投影。设置服务是用户选择的唯一写入所有者。 */
export function createTelemetryConsentGate() {
  let enabled = false;
  let generation = 0;
  const listeners = new Set<() => void>();
  return {
    setEnabled(next: boolean): void {
      if (enabled === next) return;
      enabled = next;
      generation += 1;
      for (const listener of listeners) listener();
    },
    generation(): number | null {
      return enabled ? generation : null;
    },
    epoch(): number {
      return generation;
    },
    isEnabled(): boolean {
      return enabled;
    },
    onDidChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    acceptsBatch(batch: unknown): boolean {
      return (
        enabled &&
        typeof batch === "object" &&
        batch !== null &&
        (batch as { telemetryEpoch?: unknown }).telemetryEpoch === generation
      );
    },
  };
}
