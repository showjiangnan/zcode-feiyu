// Modified by ZCode Feiyu contributors (2026).
import { errorResult, validateCall, validateContext } from "../domain/protocol.js";

export function createRuntime(options = {}) {
  const env = options.env || {};
  const request = options.request;
  const socketPath = options.brokerSocketPath || env.ZCODE_CUA_PERMISSION_BROKER_SOCKET;
  const token = options.brokerToken || env.ZCODE_CUA_BROKER_TOKEN;
  let disposed = false;
  return {
    async execute(input) {
      try {
        if (disposed || !socketPath)
          throw Object.assign(new Error("Computer Use is not connected to a local desktop"), {
            code: "unavailable",
          });
        const context = validateContext(input.context);
        const args = validateCall(input.toolName, input.arguments);
        await options.ensureBrokerAvailable?.();
        return await request({
          socketPath,
          token,
          method: "execute",
          params: { method: input.toolName, input: args, context },
          signal: input.signal,
          timeoutMs: input.toolName === "request_access" ? 120_000 : undefined,
        });
      } catch (error) {
        if (input.signal?.aborted) throw input.signal.reason;
        return errorResult(error);
      }
    },
    async closeSession(context) {
      if (socketPath && !disposed)
        await request({
          socketPath,
          token,
          method: "execute",
          params: { method: "close_session", input: {}, context: validateContext(context) },
        });
    },
    async dispose() {
      disposed = true;
    },
  };
}
