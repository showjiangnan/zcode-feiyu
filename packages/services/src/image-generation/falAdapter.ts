import { z } from "zod";
import {
  IMAGE_CHUNK_BYTES,
  IMAGE_MAX_COUNT,
  imageGenerationTicketSchema,
  type ImageGenerationConfig,
  type ImageGenerationInput,
  type ImageGenerationTicket,
} from "@zcode/shared";
import type { ImageModelOption } from "./contract.js";
import { resolveFalInputSchema, mapImageInput } from "./falModel.js";
import { readImageDimensions } from "./imageDimensions.js";
import {
  detectImageMime,
  imageApiUrl,
  readBounded,
  validateMediaUrl,
  validateQueueUrl,
} from "./falNetwork.js";

const JSON_LIMIT = 4 * 1024 * 1024;
const REQUEST_TIMEOUT = 24_000;
const imageResultSchema = z.object({
  images: z
    .array(
      z.object({
        url: z.string().url(),
        // fal 的 ImageFile 允许空尺寸，实际尺寸由下载后的文件头校验，不能提前丢弃图片。
        width: z.number().int().positive().nullish(),
        height: z.number().int().positive().nullish(),
      }),
    )
    .min(1)
    .max(IMAGE_MAX_COUNT),
});

export class FalImageAdapter {
  constructor(
    private readonly fetch: typeof globalThis.fetch,
    private readonly schemas = new Map<string, { time: number; schema: Record<string, unknown> }>(),
    private readonly images = new Map<string, { bytes: Uint8Array; time: number }>(),
  ) {}
  withDeadline(): FalImageAdapter {
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT);
    return new FalImageAdapter(
      (input, init) =>
        this.fetch(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline,
        }),
      this.schemas,
      this.images,
    );
  }
  private platform(config: ImageGenerationConfig) {
    const api = imageApiUrl(config.apiUrl);
    return api.origin === "https://queue.fal.run" ? "https://api.fal.ai" : api.origin;
  }
  private async request(
    url: string,
    key: string | undefined,
    init?: RequestInit,
  ): Promise<Response> {
    // 禁止自动重定向，防止第三方响应把认证头转发到不可信地址。
    const response = await this.fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Key ${key}` } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Image provider HTTP ${response.status}.`);
    }
    return response;
  }
  private async json(url: string, key: string | undefined, init?: RequestInit): Promise<unknown> {
    return JSON.parse(
      new TextDecoder().decode(await readBounded(await this.request(url, key, init), JSON_LIMIT)),
    );
  }
  async listModels(config: ImageGenerationConfig, key: string): Promise<ImageModelOption[]> {
    const pageSchema = z.object({
      models: z.array(
        z.object({
          endpoint_id: z.string(),
          metadata: z
            .object({ display_name: z.string().optional(), category: z.string().optional() })
            .optional(),
        }),
      ),
      has_more: z.boolean().optional(),
      next_cursor: z.string().nullable().optional(),
    });
    const models = new Map<string, ImageModelOption>();
    for (const category of ["text-to-image", "image-to-image"]) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 20; page++) {
        const query = new URLSearchParams({
          limit: "100",
          status: "active",
          category,
          ...(cursor ? { cursor } : {}),
        });
        const result = pageSchema.parse(
          await this.json(`${this.platform(config)}/v1/models?${query}`, key),
        );
        for (const item of result.models) {
          if (!["text-to-image", "image-to-image"].includes(item.metadata?.category ?? ""))
            continue;
          models.set(item.endpoint_id, {
            id: item.endpoint_id,
            name: item.metadata?.display_name ?? item.endpoint_id,
            category: item.metadata?.category ?? "",
          });
        }
        if (!result.has_more) break;
        if (!result.next_cursor || seen.has(result.next_cursor) || page === 19)
          throw new Error(
            "Image model catalogue pagination is invalid or exceeds the limit. Enter an endpoint ID directly.",
          );
        cursor = result.next_cursor;
        seen.add(cursor);
      }
    }
    return [...models.values()];
  }
  async model(config: ImageGenerationConfig, endpoint: string, key: string) {
    const api = imageApiUrl(config.apiUrl),
      cacheKey = `${api.origin}:${endpoint}`,
      cached = this.schemas.get(cacheKey);
    if (cached && Date.now() - cached.time < 300_000) return cached.schema;
    let doc: unknown;
    if (api.origin === "https://queue.fal.run") {
      // 带 Key 的目录 expansion 会把上游取 schema 失败包装成 HTTP 200 + error，
      // 曾被误判为模型不支持。官方 Queue 改读模型页链接的公开 Schema，且不发送密钥。
      doc = await this.json(
        `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${encodeURIComponent(endpoint)}`,
        undefined,
      );
    } else {
      const result = z
        .object({ models: z.array(z.object({ endpoint_id: z.string(), openapi: z.unknown() })) })
        .parse(
          await this.json(
            `${this.platform(config)}/v1/models?endpoint_id=${encodeURIComponent(endpoint)}&expand=openapi-3.0`,
            key,
          ),
        );
      const item = result.models.find((item) => item.endpoint_id === endpoint);
      if (!item) throw new Error("Image model was not found in the provider catalogue.");
      doc = item.openapi;
    }
    const schema = resolveFalInputSchema(doc);
    this.schemas.set(cacheKey, { schema, time: Date.now() });
    return schema;
  }
  async validate(config: ImageGenerationConfig, key: string) {
    const schema = await this.model(config, config.model, key);
    mapImageInput(
      schema,
      { prompt: "connection check", count: 1, format: "png", referenceImages: [] },
      [],
    );
    if (config.editModel) {
      const edit = await this.model(config, config.editModel, key);
      mapImageInput(
        edit,
        { prompt: "connection check", count: 1, format: "png", referenceImages: [] },
        ["https://example.invalid/reference.png"],
      );
    }
    // 模型目录允许匿名访问；价格接口需要 API scope，才足以验证密钥且不产生推理费用。
    await this.json(
      `${this.platform(config)}/v1/models/pricing?endpoint_id=${encodeURIComponent(config.model)}`,
      key,
    );
  }
  async prepare(
    config: ImageGenerationConfig,
    input: ImageGenerationInput,
    references: string[],
    key: string,
  ) {
    const endpoint = references.length ? config.editModel : config.model;
    if (!endpoint)
      throw new Error("Configure an image editing model before supplying reference images.");
    const schema = await this.model(config, endpoint, key);
    const payload = mapImageInput(schema, input, references);
    return { endpoint, payload };
  }
  async submit(
    config: ImageGenerationConfig,
    prepared: { endpoint: string; payload: Record<string, unknown> },
    key: string,
  ) {
    const { endpoint, payload } = prepared;
    const result = z
      .object({
        request_id: z.string(),
        status_url: z.string(),
        response_url: z.string(),
        cancel_url: z.string(),
      })
      .parse(
        await this.json(`${imageApiUrl(config.apiUrl).href.replace(/\/$/, "")}/${endpoint}`, key, {
          method: "POST",
          body: JSON.stringify(payload),
          headers: {
            "X-Fal-Object-Lifecycle-Preference": JSON.stringify({
              expiration_duration_seconds: 3600,
              initial_acl: { default: "forbid", rules: [] },
            }),
          },
        }),
      );
    return imageGenerationTicketSchema.parse({
      requestId: result.request_id,
      apiUrl: config.apiUrl,
      endpoint,
      statusUrl: validateQueueUrl(result.status_url, config.apiUrl),
      responseUrl: validateQueueUrl(result.response_url, config.apiUrl),
      cancelUrl: validateQueueUrl(result.cancel_url, config.apiUrl),
    });
  }
  private async result(ticket: ImageGenerationTicket, key: string) {
    return imageResultSchema.parse(
      await this.json(validateQueueUrl(ticket.responseUrl, ticket.apiUrl), key),
    );
  }
  async status(ticket: ImageGenerationTicket, key: string) {
    const result = z
      .object({
        status: z.enum(["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]),
        error: z.unknown().optional(),
      })
      .parse(await this.json(validateQueueUrl(ticket.statusUrl, ticket.apiUrl), key));
    if (result.error) throw new Error("Image generation failed at the provider.");
    if (result.status === "COMPLETED")
      return {
        type: "status" as const,
        status: "completed" as const,
        imageCount: (await this.result(ticket, key)).images.length,
      };
    return {
      type: "status" as const,
      status: result.status === "IN_QUEUE" ? ("queued" as const) : ("running" as const),
    };
  }
  async cancel(ticket: ImageGenerationTicket, key: string) {
    const response = await this.fetch(validateQueueUrl(ticket.cancelUrl, ticket.apiUrl), {
      method: "PUT",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      headers: { Authorization: `Key ${key}` },
    });
    await response.body?.cancel();
    if (![200, 202, 400, 404].includes(response.status))
      throw new Error(`Image cancellation HTTP ${response.status}.`);
    return {
      type: "cancelled" as const,
      disposition:
        response.status === 404
          ? ("not_found" as const)
          : response.status === 400
            ? ("already_completed" as const)
            : ("requested" as const),
    };
  }
  async download(ticket: ImageGenerationTicket, index: number, offset: number, key: string) {
    const result = await this.result(ticket, key),
      item = result.images[index];
    if (!item) throw new Error("Image result index is unavailable.");
    const url = validateMediaUrl(item.url, ticket.apiUrl);
    let cached = this.images.get(url);
    if (!cached || Date.now() - cached.time > 60_000) {
      const headers: Record<string, string> = {};
      if (new URL(url).hostname === "v3b.fal.media") {
        const token = z.object({ token: z.string().min(1) }).parse(
          await this.json("https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3", key, {
            method: "POST",
            body: JSON.stringify({ expiration_seconds: 120 }),
          }),
        );
        headers.Authorization = `Bearer ${token.token}`;
      }
      const response = await this.fetch(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          `Image download HTTP ${response.status}; the provider file may have expired.`,
        );
      }
      const bytes = await readBounded(response);
      detectImageMime(bytes);
      cached = { bytes, time: Date.now() };
      // 缓存仅用于分块传输，最多两张原图；作业事实仍只属于 CLI Session Store。
      if (this.images.size >= 2) this.images.delete(this.images.keys().next().value!);
      this.images.set(url, cached);
    }
    if (offset >= cached.bytes.length) throw new Error("Image chunk offset is out of bounds.");
    const end = Math.min(offset + IMAGE_CHUNK_BYTES, cached.bytes.length);
    return {
      type: "chunk" as const,
      data: Buffer.from(cached.bytes.subarray(offset, end)).toString("base64"),
      nextOffset: end === cached.bytes.length ? null : end,
      mime: detectImageMime(cached.bytes),
      totalBytes: cached.bytes.length,
      ...readImageDimensions(cached.bytes, detectImageMime(cached.bytes)),
    };
  }
}
