// Modified by ZCode Feiyu.
export const REQUEST_ID_HEADER = "x-request-id";

export function resolveRequestUrl(resource: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof resource === "string") return resource;
  if (resource instanceof URL) return resource.toString();
  return resource.url;
}

export function safeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    // 带凭证的 URL 与其 origin 不是同一信任面，直接判为不可信。
    if (url.username !== "" || url.password !== "") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

export /** 服务端在响应头里回带的 request id。缺失时返回 undefined。 */
function readServerRequestId(response: Response): string | undefined {
  const value = response.headers.get(REQUEST_ID_HEADER)?.trim();
  return value ? value : undefined;
}

export /**
 * 把服务端 request id 附到分类错误的 message 上。
 *
 * tool call 分类错误直接向上展示，使用紧凑的 `message - requestId` 形态。连接期 request id
 * 由 adapter 的结构化 status diagnostic 统一拼接，避免 SDK 包装前后重复。
 */
function withServerRequestId(message: string, response: Response): string {
  const requestId = readServerRequestId(response);
  return requestId ? `${message} - ${requestId}` : message;
}

export /** 请求路径（不含 query）。query 可能带用户内容，因此丢弃。 */
function safePath(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return "(unparsable)";
  }
}

export function byteLength(body: unknown): number | undefined {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (body instanceof Uint8Array) return body.byteLength;
  return undefined;
}

export function numericHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export /**
 * 从 JSON-RPC 请求体里取出**结构性**字段用于关联日志：method / id / tools\_call 的工具名 /
 * `_meta` 里的 trace\_id。
 * 刻意不取 `params.arguments`——那里是用户输入（如搜索词），不属于"没那么敏感"的范畴。
 *
 * trace\_id 仅在 `tools/call` 上存在：`initialize` / `tools/list` 由 SDK 在建连阶段发出，
 * 没有 `_meta`，因此那两个请求只有 request id、没有 trace id。这是预期的，不是缺陷。
 */
function describeJsonRpc(body: unknown): {
  id?: number | string;
  method?: string;
  spanId?: string;
  toolName?: string;
  traceId?: string;
} {
  if (typeof body !== "string" || body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const method = typeof record.method === "string" ? record.method : undefined;
    const id =
      typeof record.id === "number" || typeof record.id === "string" ? record.id : undefined;
    const params = isPlainRecord(record.params) ? record.params : undefined;
    const toolName = params && typeof params.name === "string" ? params.name : undefined;
    // mcpRequestMeta 把 trace 写在 params._meta 上（同时有扁平键与 com.zcode/ 命名空间键）。
    const meta = params && isPlainRecord(params._meta) ? params._meta : undefined;
    const traceId = meta && typeof meta.trace_id === "string" ? meta.trace_id : undefined;
    // span 才是"一次 tool call"的粒度：traceId 覆盖整个顶层 session，同一 session 里的
    // 多次调用共用它，用它做关联会串号。
    const spanId = meta && typeof meta.span_id === "string" ? meta.span_id : undefined;
    return {
      ...(id !== undefined ? { id } : {}),
      ...(method ? { method } : {}),
      ...(spanId ? { spanId } : {}),
      ...(toolName ? { toolName } : {}),
      ...(traceId ? { traceId } : {}),
    };
  } catch {
    return {};
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export /**
 * 身份头的**非敏感摘要**：只有名字、是否成对、以及 targetType 的枚举值。
 * 绝不输出 Authorization 或 api-key 的值，连截断值也不输出——日志留存周期不受控。
 */
function describeAbortSignal(signal: AbortSignal | null | undefined): string {
  if (!signal) return "none";
  return signal.aborted ? "already-aborted" : "armed";
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 丢弃 body 失败不影响分类结论。
  }
}
