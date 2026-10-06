import {
  normalizeRcsEndpoint,
  RCS_BRIDGE_VERSION,
  RCS_RPC_CODEC_VERSION,
  RCS_AGENT_WIRE_VERSION,
} from "@zcode/shared";

export async function rcsRequest<T>(
  endpoint: string,
  path: string,
  options: { token?: string; method?: string; body?: unknown } = {},
): Promise<T> {
  const origin = normalizeRcsEndpoint(endpoint);
  const response = await fetch(`${origin}/api/rcs/v1${path}`, {
    method: options.method ?? "GET",
    redirect: "error",
    signal: AbortSignal.timeout(25_000),
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!response.ok) {
    const result = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
    throw new Error(result.error?.code ?? `RCS_HTTP_${response.status}`);
  }
  return (await response.json()) as T;
}

export async function rcsLogin(endpoint: string, key: string, name: string) {
  const meta = await rcsRequest<{
    bridgeVersion: number;
    rpcCodec: number;
    agentWire: number;
    serverInstanceId: string;
  }>(endpoint, "/meta");
  if (
    meta.bridgeVersion !== RCS_BRIDGE_VERSION ||
    meta.rpcCodec !== RCS_RPC_CODEC_VERSION ||
    meta.agentWire !== RCS_AGENT_WIRE_VERSION
  )
    throw new Error("VERSION_INCOMPATIBLE");
  const session = await rcsRequest<{ token: string; id: string; expiresAt: number }>(
    endpoint,
    "/auth/session",
    { method: "POST", body: { key, role: "desktop", name } },
  );
  return { ...session, serverInstanceId: meta.serverInstanceId };
}
