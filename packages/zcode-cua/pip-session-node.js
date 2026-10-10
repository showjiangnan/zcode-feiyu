// Modified by ZCode Feiyu contributors (2026).
import { request } from "./src/adapters/ipc-client.js";
export function createPipSessionClient(options = {}) {
  let closed = false;
  return {
    enabled: Boolean(options.socketPath && options.token),
    async connect() {
      if (closed) throw new Error("Presentation transport closed");
    },
    async send(event) {
      if (closed || !options.socketPath || !options.token)
        return { applied: false, reason: "transport-disabled" };
      return request({
        socketPath: options.socketPath,
        token: options.token,
        method: "pip_event",
        params: event,
        timeoutMs: options.timeoutMs || 5000,
      });
    },
    close() {
      closed = true;
    },
  };
}
