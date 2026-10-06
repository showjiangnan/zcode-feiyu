import {
  normalizeRcsEndpoint,
  type RcsDevice,
  type RcsHost,
  type RcsAttachment,
  type RcsClient,
} from "@zcode/shared";

export interface RcsHttpOptions {
  endpoint: string;
  request?: typeof fetch;
  cookieAuthentication?: boolean;
  now?: () => number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export class RcsHttpClient {
  readonly endpoint: string;
  private readonly request: typeof fetch;
  private token?: string;
  private expires = 0;
  private refreshFlight?: Promise<void>;
  constructor(private readonly options: RcsHttpOptions) {
    this.endpoint = normalizeRcsEndpoint(options.endpoint);
    this.request = options.request ?? globalThis.fetch.bind(globalThis);
  }
  async call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(this.options.signal?.reason);
    this.options.signal?.addEventListener("abort", abort, { once: true });
    if (this.options.signal?.aborted) abort();
    const deadline = setTimeout(
      () => controller.abort(new Error("RCS_HTTP_TIMEOUT")),
      this.options.timeoutMs ?? 25_000,
    );
    let response: Response;
    try {
      response = await this.request(`${this.endpoint}/api/rcs/v1${path}`, {
        method,
        credentials: this.options.cookieAuthentication ? "include" : "omit",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(!this.options.cookieAuthentication && this.token
            ? { Authorization: `Bearer ${this.token}` }
            : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } finally {
      clearTimeout(deadline);
      this.options.signal?.removeEventListener("abort", abort);
    }
    if (!response.ok) {
      const value = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
      throw new Error(value.error?.code ?? `RCS_HTTP_${response.status}`);
    }
    return (await response.json()) as T;
  }
  async login(key: string, name = "ZCode client"): Promise<void> {
    await this.checkCompatibility();
    const result = await this.call<{ token: string; expiresAt: number }>("/auth/session", "POST", {
      key,
      role: "client",
      name,
    });
    this.token = this.options.cookieAuthentication ? undefined : result.token;
    this.expires = result.expiresAt;
  }
  async restore(): Promise<void> {
    await this.checkCompatibility();
    const result = await this.call<{ expiresAt: number }>("/auth/session");
    this.expires = result.expiresAt;
  }
  async checkCompatibility(): Promise<void> {
    const meta = await this.call<{ bridgeVersion: number; rpcCodec: number; agentWire: number }>(
      "/meta",
    );
    if (meta.bridgeVersion !== 1 || meta.rpcCodec !== 1 || meta.agentWire !== 3)
      throw new Error("VERSION_INCOMPATIBLE");
  }
  async refreshIfNeeded(): Promise<void> {
    if ((this.options.now ?? Date.now)() / 1000 + 300 < this.expires) return;
    if (!this.refreshFlight) {
      const flight = this.call<{ expiresAt: number }>("/auth/refresh", "POST")
        .then((value) => {
          this.expires = value.expiresAt;
        })
        .finally(() => {
          if (this.refreshFlight === flight) this.refreshFlight = undefined;
        });
      this.refreshFlight = flight;
    }
    return this.refreshFlight;
  }
  async logout(): Promise<void> {
    try {
      await this.call("/auth/session", "DELETE");
    } finally {
      this.token = undefined;
      this.expires = 0;
    }
  }
  resourceUrl(attachmentId: string, path: string): string {
    return `${this.endpoint}/api/rcs/v1/attachments/${encodeURIComponent(attachmentId)}/resource?${new URLSearchParams({ path })}`;
  }
  async readResource(attachmentId: string, path: string, range?: string): Promise<Response> {
    const response = await this.request(this.resourceUrl(attachmentId, path), {
      credentials: this.options.cookieAuthentication ? "include" : "omit",
      redirect: "error",
      headers: {
        ...(!this.options.cookieAuthentication && this.token
          ? { Authorization: `Bearer ${this.token}` }
          : {}),
        ...(range ? { Range: range } : {}),
      },
    });
    if (!response.ok) throw new Error(`RCS_RESOURCE_${response.status}`);
    return response;
  }
  listDevices(): Promise<RcsDevice[]> {
    return this.call("/devices");
  }
  listHosts(deviceId: string): Promise<RcsHost[]> {
    return this.call(`/devices/${encodeURIComponent(deviceId)}/hosts`);
  }
  attach(input: {
    deviceId: string;
    hostId: string;
    hostGeneration: string;
    workspaceHandle: string;
  }): Promise<RcsAttachment> {
    return this.call("/attachments", "POST", input);
  }
  detach(id: string): Promise<void> {
    return this.call(`/attachments/${encodeURIComponent(id)}`, "DELETE");
  }
  socketTicket(id: string): Promise<{ ticket: string }> {
    return this.call(`/attachments/${encodeURIComponent(id)}/socket-ticket`, "POST");
  }
  listClients(): Promise<RcsClient[]> {
    return this.call("/clients");
  }
  revokeClient(id: string): Promise<void> {
    return this.call(`/clients/${encodeURIComponent(id)}`, "DELETE");
  }
}
