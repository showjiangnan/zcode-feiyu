// Modified by ZCode Feiyu.
import { randomUUID } from "node:crypto";
/** 扫描取消只管理在途 IO，不保存选择、导入映射或会话状态。 */
export class ImportScanRequests {
  private readonly pending = new Map<string, AbortController>();
  constructor(private readonly shutdown: AbortSignal) {}
  async run<T>(
    requestedId: string | undefined,
    action: (signal: AbortSignal, id: string) => Promise<T>,
  ): Promise<T> {
    const id = requestedId || randomUUID();
    if (!/^[\w-]{1,160}$/u.test(id) || this.pending.has(id))
      throw new Error("invalid_scan_request_id");
    const controller = new AbortController();
    const stop = () => controller.abort(new Error("cancelled"));
    this.pending.set(id, controller);
    this.shutdown.addEventListener("abort", stop, { once: true });
    try {
      this.shutdown.throwIfAborted();
      const result = await action(controller.signal, id);
      controller.signal.throwIfAborted();
      return result;
    } finally {
      this.shutdown.removeEventListener("abort", stop);
      this.pending.delete(id);
    }
  }
  cancel(id: string): void {
    this.pending.get(id)?.abort(new Error("cancelled"));
  }
}
