// Modified by ZCode Feiyu.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { chatGPTSubscriptionViewSchema } from "@zcode/shared";
import type { ChatGPTSubscriptionService } from "../app/service.js";
import {
  safeSubscriptionError,
  parseSubscriptionError,
  ChatGPTSubscriptionError,
  isSubscriptionTokenRejection,
} from "../domain/errors.js";
import { projectSubscriptionRequest } from "../domain/responses.js";
import { validateSubscriptionStream } from "./responseStream.js";

/** 私有端口只提供固定推理和脱敏读面；浏览器、插件与 RCS 没有该 capability。 */
export async function startSubscriptionBroker(
  owner: ChatGPTSubscriptionService,
  upstream: typeof fetch,
) {
  const capability = randomBytes(48).toString("base64url");
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const controller = new AbortController();
    response.once("close", () => {
      if (!response.writableFinished) controller.abort();
    });
    let unregister: (() => void) | undefined;
    try {
      const received = Buffer.from(request.headers.authorization ?? ""),
        expected = Buffer.from(`Bearer ${capability}`);
      if (
        received.length !== expected.length ||
        !timingSafeEqual(received, expected) ||
        request.headers.origin
      )
        throw new ChatGPTSubscriptionError("managed_host_unauthorized", 403);
      response.setHeader("cache-control", "no-store");
      if (request.method === "GET" && request.url === "/view") {
        return json(
          response,
          200,
          chatGPTSubscriptionViewSchema.parse(await owner.execute({ type: "read" })),
        );
      }
      if (request.method === "POST" && request.url === "/refresh-models") {
        return json(
          response,
          200,
          chatGPTSubscriptionViewSchema.parse(await owner.execute({ type: "refresh-models" })),
        );
      }
      if (request.method === "POST" && request.url === "/execution/end") {
        const value = (await readJson(request)) as { id?: unknown };
        if (typeof value.id !== "string")
          throw new ChatGPTSubscriptionError("connection_binding_invalid", 400);
        owner.releaseExecution(value.id);
        return json(response, 200, { ok: true });
      }
      if (request.method !== "POST" || request.url !== "/responses")
        throw new ChatGPTSubscriptionError("managed_route_not_supported", 404);
      const profileId = request.headers["x-zcode-subscription-profile"],
        rawGeneration = request.headers["x-zcode-subscription-generation"];
      if (
        typeof profileId !== "string" ||
        !/^[a-f0-9-]{36}$/u.test(profileId) ||
        typeof rawGeneration !== "string" ||
        !/^\d+$/u.test(rawGeneration)
      )
        throw new ChatGPTSubscriptionError("connection_binding_invalid", 400);
      const id = request.headers["x-zcode-execution-id"],
        startedAt = Number(request.headers["x-zcode-execution-started-at"]);
      if (
        id !== undefined &&
        (typeof id !== "string" ||
          id.length > 200 ||
          !Number.isFinite(startedAt) ||
          startedAt > Date.now())
      )
        throw new ChatGPTSubscriptionError("connection_binding_invalid", 400);
      const parentId = request.headers["x-zcode-execution-parent"];
      if (parentId !== undefined && (typeof parentId !== "string" || parentId.length > 200))
        throw new ChatGPTSubscriptionError("connection_binding_invalid", 400);
      await owner.bindExecution(
        profileId,
        Number(rawGeneration),
        typeof id === "string" ? { id, startedAt, parentId } : undefined,
      );
      const boundModels = owner.executionModels?.(typeof id === "string" ? id : undefined);
      const rawBody = await readJson(request);
      unregister = owner.registerRequest(profileId, controller);
      let profile = await owner.credentials(profileId, Number(rawGeneration), controller.signal);
      if (!profile.usageAcknowledged)
        throw new ChatGPTSubscriptionError("subscription_usage_confirmation_required", 403);
      const modelId =
        rawBody && typeof rawBody === "object" && "model" in rawBody ? rawBody.model : undefined;
      const model = (boundModels ?? profile.models).find((model) => model.slug === modelId);
      if (!model) throw new ChatGPTSubscriptionError("model_not_available", 400);
      const body = projectSubscriptionRequest(rawBody, model);
      const send = () =>
        upstream("https://api.openai.com/v1/responses", {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${profile.tokens!.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      let result = await send();
      if (result.status === 401) {
        const failure = parseSubscriptionError(
          await result.json().catch(() => ({})),
          result.status,
          result.headers.get("x-request-id") ?? undefined,
        );
        if (!isSubscriptionTokenRejection(failure.code)) throw failure;
        // 只刷新确认为令牌失效的 401；权限、用量和参数错误不重复 OAuth。
        profile = await owner.credentials(
          profileId,
          Number(rawGeneration),
          controller.signal,
          profile.credentialRevision,
        );
        result = await send();
      }
      if (!result.ok)
        throw parseSubscriptionError(
          await result.json().catch(() => ({})),
          result.status,
          result.headers.get("x-request-id") ?? undefined,
        );
      const stream = validateSubscriptionStream(result, controller.signal);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        ...(result.headers.get("x-request-id")
          ? { "x-request-id": result.headers.get("x-request-id")! }
          : {}),
      });
      for await (const chunk of stream.body!) {
        if (controller.signal.aborted) break;
        if (!response.write(chunk)) await once(response, "drain", { signal: controller.signal });
      }
      response.end();
    } catch (error) {
      const safe = safeSubscriptionError(error);
      if (response.destroyed) return;
      const payload = {
        error: {
          code: safe.code,
          message: safe.message,
          ...(safe.param ? { param: safe.param } : {}),
          ...(safe.incompleteReason ? { incomplete_reason: safe.incompleteReason } : {}),
        },
        request_id: safe.requestId,
      };
      if (response.headersSent) {
        response.end(
          `event: error\ndata: ${JSON.stringify({ type: "error", code: safe.code, message: safe.message, request_id: safe.requestId, ...(safe.incompleteReason ? { incomplete_reason: safe.incompleteReason } : {}) })}\n\n`,
        );
      } else json(response, safe.status && safe.status >= 400 ? safe.status : 400, payload);
    } finally {
      unregister?.();
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new ChatGPTSubscriptionError("managed_host_unavailable");
  return {
    env: {
      ZCODE_SUBSCRIPTION_BROKER_URL: `http://127.0.0.1:${address.port}`,
      ZCODE_SUBSCRIPTION_BROKER_CAPABILITY: capability,
    },
    async dispose() {
      owner.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new ChatGPTSubscriptionError("request_too_large", 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ChatGPTSubscriptionError("invalid_request", 400);
  }
}
function json(response: ServerResponse, status: number, value: unknown) {
  response
    .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
    .end(JSON.stringify(value));
}
