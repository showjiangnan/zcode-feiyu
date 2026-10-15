// Modified by ZCode Feiyu.
import { isTeamorouterEndpoint, type TeamorouterBalance } from "@zcode/shared";

export async function queryTeamorouterBalance(
  input: {
    readonly apiType?: string | null;
    readonly baseUrl?: string | null;
    readonly apiKey?: string | null;
  },
  fetcher: typeof fetch = globalThis.fetch,
): Promise<TeamorouterBalance> {
  if (
    !isTeamorouterEndpoint(input.baseUrl) ||
    !["openai-responses", "anthropic-messages"].includes(input.apiType ?? "")
  )
    throw new Error("teamorouter:unsupported");
  if (!input.apiKey?.trim()) throw new Error("teamorouter:missing-key");
  try {
    const response = await fetcher("https://api.teamorouter.com/v1/billing/balance", {
      method: "GET",
      headers: { Authorization: `Bearer ${input.apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `teamorouter:${response.status === 401 || response.status === 403 ? "unauthorized" : response.status === 429 ? "rate-limited" : "server-error"}`,
      );
    }
    if (!response.body) throw new Error("teamorouter:invalid-response");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 65_536) throw new Error("teamorouter:invalid-response");
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("teamorouter:invalid-response");
    }
    const balance =
      parsed && typeof parsed === "object" && "balance" in parsed ? parsed.balance : null;
    if (
      !balance ||
      typeof balance !== "object" ||
      !("value" in balance) ||
      !("currency" in balance) ||
      typeof balance.value !== "string" ||
      balance.value.length > 100 ||
      !/^-?\d+(?:\.\d+)?$/u.test(balance.value) ||
      typeof balance.currency !== "string" ||
      !/^[A-Z][A-Z0-9]{1,15}$/u.test(balance.currency)
    )
      throw new Error("teamorouter:invalid-response");
    return { value: balance.value, currency: balance.currency };
  } catch (error) {
    // 上游正文和网络异常可能含凭据；RPC 只返回固定分类。
    if (
      error instanceof Error &&
      /^teamorouter:(unauthorized|rate-limited|server-error|invalid-response)$/u.test(error.message)
    )
      throw error;
    throw new Error("teamorouter:network-error");
  }
}
