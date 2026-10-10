// Modified by ZCode Feiyu contributors (2026).
import { createServer } from "node:net";
import { chmod, rm } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { CuaError, LIMITS, PROTOCOL } from "../domain/protocol.js";

export async function serve({ socketPath, token, execute, diagnostics }) {
  const clients = new Set();
  let inFlight = 0;
  let closed = false;
  const server = createServer((socket) => {
    if (closed || clients.size >= LIMITS.connections) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    socket.setTimeout(120_000, () => socket.destroy());
    const controller = new AbortController();
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let received = 0;
    let admitted = false;
    socket.on("error", () => controller.abort());
    socket.on("close", () => {
      clients.delete(socket);
      controller.abort();
    });
    const reply = (body) => {
      if (socket.destroyed) return;
      let line = JSON.stringify({ protocol: PROTOCOL, ...body });
      if (Buffer.byteLength(line) > LIMITS.responseBytes)
        line = JSON.stringify({
          protocol: PROTOCOL,
          id: body.id,
          ok: false,
          error: { code: "response_too_large", message: "Broker response exceeded its limit" },
        });
      socket.end(`${line}\n`);
    };
    socket.on("data", (chunk) => {
      if (admitted) {
        socket.destroy();
        return;
      }
      received += chunk.length;
      if (received > LIMITS.requestBytes) {
        socket.destroy();
        return;
      }
      buffer += decoder.write(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      admitted = true;
      let request;
      try {
        request = JSON.parse(buffer.slice(0, newline));
        if (request.protocol !== PROTOCOL)
          throw new CuaError("version_mismatch", "Unsupported Computer Use protocol");
        if (typeof request.id !== "string" || request.id.length > 255)
          throw new CuaError("invalid_request", "Request ID is invalid");
        if (!diagnostics.has(request.method)) {
          const actual = Buffer.from(typeof request.token === "string" ? request.token : "");
          const expected = Buffer.from(token);
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
            throw new CuaError(
              "not_authorized",
              "Computer Use requires trusted local task credentials",
            );
        }
        if (inFlight >= LIMITS.inFlight)
          throw new CuaError("busy", "Computer Use has too many operations in flight");
      } catch (error) {
        reply({
          id: request?.id,
          ok: false,
          error: { code: error.code || "invalid_request", message: error.message },
        });
        return;
      }
      inFlight += 1;
      void execute(request.method, request.params, controller.signal)
        .then(
          (result) => reply({ id: request.id, ok: true, result }),
          (error) =>
            reply({
              id: request.id,
              ok: false,
              error: {
                code: error.code || "native_error",
                message: error.message,
                ...(error.details ? { details: error.details } : {}),
              },
            }),
        )
        .finally(() => {
          inFlight -= 1;
        });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  if (process.platform !== "win32") await chmod(socketPath, 0o600);
  return {
    async close() {
      closed = true;
      for (const client of clients) client.destroy();
      await new Promise((resolve) => server.close(resolve));
      if (process.platform !== "win32") await rm(socketPath, { force: true });
    },
  };
}
