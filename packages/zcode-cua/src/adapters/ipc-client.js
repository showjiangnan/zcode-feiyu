// Modified by ZCode Feiyu contributors (2026).
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { CuaError, LIMITS, PROTOCOL } from "../domain/protocol.js";

export function request({
  socketPath,
  method,
  params,
  timeoutMs = LIMITS.operationMs,
  token,
  signal,
}) {
  if (signal?.aborted)
    return Promise.reject(
      signal.reason || new CuaError("cancelled", "Computer operation cancelled"),
    );
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = createConnection(socketPath);
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let bytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () =>
      finish(signal.reason || new CuaError("cancelled", "Computer operation cancelled"));
    const timer = setTimeout(
      () =>
        finish(
          new CuaError(
            "deadline",
            "Computer operation timed out; inspect the result before retrying",
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ protocol: PROTOCOL, id, token, method, params })}\n`),
    );
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > LIMITS.responseBytes)
        return finish(new CuaError("response_too_large", "Computer Use response exceeds 32 MiB"));
      buffer += decoder.write(chunk);
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, end));
        if (response.protocol !== PROTOCOL)
          throw new CuaError("version_mismatch", "Computer Use response protocol mismatch");
        if (response.id !== id)
          throw new CuaError("invalid_response", "Computer Use response ID mismatch");
        if (response.ok !== true)
          throw new CuaError(
            response.error?.code || "native_error",
            response.error?.message || "Computer Use request failed",
            response.error?.details,
          );
        finish(undefined, response.result);
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      if (!settled)
        finish(
          new CuaError("transport_closed", "Computer Use transport closed; result may be unknown"),
        );
    });
  });
}
