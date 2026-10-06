import { filterTeamorouterModels, isTeamorouterEndpoint } from "@zcode/shared";

export async function discoverTeamorouterModels(
  input: {
    readonly apiType?: string | null;
    readonly baseUrl?: string | null;
    readonly apiKey?: string | null;
  },
  fetcher: typeof fetch = globalThis.fetch,
): Promise<string[]> {
  if (
    !isTeamorouterEndpoint(input.baseUrl) ||
    !["openai-responses", "anthropic-messages"].includes(input.apiType ?? "")
  )
    throw new Error("teamorouter:unsupported");
  if (!input.apiKey?.trim()) throw new Error("teamorouter:missing-key");
  try {
    const response = await fetcher("https://api.teamorouter.com/v1/models", {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        response.status === 401 || response.status === 403
          ? "teamorouter:unauthorized"
          : "teamorouter:server-error",
      );
    }
    if (!response.body) throw new Error("teamorouter:invalid-response");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 2_000_000) throw new Error("teamorouter:invalid-response");
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("teamorouter:invalid-response");
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("data" in parsed) ||
      !Array.isArray(parsed.data) ||
      parsed.data.length > 10_000
    )
      throw new Error("teamorouter:invalid-response");
    const ids = parsed.data.map((item: unknown) => {
      if (
        !item ||
        typeof item !== "object" ||
        !("id" in item) ||
        typeof item.id !== "string" ||
        item.id.length > 200
      )
        throw new Error("teamorouter:invalid-response");
      return item.id;
    });
    const compatible = filterTeamorouterModels(ids, input.apiType!);
    if (!compatible.length) throw new Error("teamorouter:no-models");
    return compatible;
  } catch (error) {
    // 网络/上游异常可能包含鉴权或响应正文，跨 RPC 只返回固定错误分类。
    if (error instanceof Error && error.message.startsWith("teamorouter:")) throw error;
    throw new Error("teamorouter:network-error");
  }
}
