// Modified by ZCode Feiyu.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { ChatGPTSubscriptionError } from "../domain/errors.js";

export async function listenSubscriptionCallback(
  state: string,
  signal: AbortSignal,
  savedClientId?: string,
) {
  let settled = false;
  let accept!: (value: { code: string; clientId: string }) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<{ code: string; clientId: string }>((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  void result.catch(() => undefined);
  const finish = (error?: Error, value?: { code: string; clientId: string }) => {
    if (settled) return;
    settled = true;
    if (error) reject(error);
    else if (value) accept(value);
  };
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const expectedHost = `127.0.0.1:${port}`;
    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://${expectedHost}`);
    } catch {
      response.writeHead(400).end("Invalid request");
      return;
    }
    if (
      request.method !== "GET" ||
      request.headers.host !== expectedHost ||
      url.origin !== `http://${expectedHost}` ||
      url.pathname !== "/auth/callback" ||
      settled
    ) {
      response.writeHead(404).end("Not found");
      return;
    }
    const received = Buffer.from(url.searchParams.get("state") ?? "");
    const expected = Buffer.from(state);
    if (
      url.searchParams.getAll("state").length !== 1 ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      response.writeHead(400).end("Invalid sign-in attempt");
      return;
    }
    if (url.searchParams.has("error")) {
      finish(
        new ChatGPTSubscriptionError(
          url.searchParams.get("error") === "access_denied"
            ? "authorization_cancelled"
            : "authorization_failed",
        ),
      );
      response.writeHead(200).end("Sign-in cancelled. Return to ZCode.");
      return;
    }
    const code = url.searchParams.get("code");
    const clientId = url.searchParams.get("client_id") ?? savedClientId;
    if (
      !code ||
      url.searchParams.getAll("code").length !== 1 ||
      !clientId ||
      clientId === "dynamic_agent_client" ||
      url.searchParams.getAll("client_id").length > 1 ||
      (savedClientId && clientId !== savedClientId)
    ) {
      finish(new ChatGPTSubscriptionError("registration_callback_invalid"));
      response.writeHead(400).end("Invalid registration callback");
      return;
    }
    finish(undefined, { code, clientId });
    response.writeHead(200).end("Sign-in received. You can close this page and return to ZCode.");
  });
  await new Promise<void>((resolve, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", fail);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new ChatGPTSubscriptionError("callback_unavailable");
  const abort = () =>
    finish(
      new ChatGPTSubscriptionError(
        signal.reason instanceof Error && signal.reason.name === "TimeoutError"
          ? "authorization_timeout"
          : "authorization_cancelled",
      ),
    );
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return {
    redirectUri: `http://127.0.0.1:${address.port}/auth/callback`,
    result,
    async close() {
      signal.removeEventListener("abort", abort);
      finish(new ChatGPTSubscriptionError("authorization_cancelled"));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
