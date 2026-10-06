import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  decodeRcsFrame,
  encodeRcsFrame,
  rcsControlSchema,
  RCS_MAX_BUFFER_BYTES,
  type RcsStatus,
  type RcsSettings,
  type RcsClient,
} from "@zcode/shared";
import type { RcsSettingsStore } from "./rcsSettingsStore.js";
import { rcsLogin, rcsRequest } from "./rcsHttp.js";
import type { RcsHostBridge } from "./rcsHostBridge.js";

interface Link {
  socket: WebSocket;
  token: string;
  config: RcsSettings;
  expiry: number;
  generation: number;
  pong: number;
  timer?: ReturnType<typeof setInterval>;
}
const terminalErrors = new Set([
  "AUTH_FAILED",
  "KEY_REVOKED",
  "VERSION_INCOMPATIBLE",
  "RCS_SYSTEM_PROTECTION_UNAVAILABLE",
]);
const socketUrl = (endpoint: string) => `${endpoint.replace(/^http/, "ws")}/ws/rcs/v1/desktop`;

/** 唯一设备连接 owner；异步完成只允许操作其创建时的 generation。 */
export class RcsConnection {
  private generation = 0;
  private link?: Link;
  private retry?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private status: RcsStatus = { state: "disabled" };
  constructor(
    private readonly store: RcsSettingsStore,
    private readonly host: RcsHostBridge,
  ) {}
  getStatus(): RcsStatus {
    return { ...this.status };
  }
  async apply(): Promise<void> {
    const generation = ++this.generation;
    this.stopLink();
    this.attempt = 0;
    let config: RcsSettings;
    try {
      config = await this.store.getSettings();
    } catch (error) {
      // 配置读取失败必须显示错误，不能在启动时被忽略并伪装成已关闭。
      if (generation === this.generation)
        this.status = { state: "error", error: "RCS_SETTINGS_UNAVAILABLE" };
      throw error;
    }
    if (generation !== this.generation) return;
    if (!config.enabled) {
      this.status = { state: "disabled" };
      return;
    }
    this.status = { state: "connecting" };
    void this.connect(generation, config);
  }
  private stopLink(): void {
    clearTimeout(this.retry);
    this.retry = undefined;
    const old = this.link;
    this.link = undefined;
    if (old) {
      clearInterval(old.timer);
      old.socket.terminate();
      void rcsRequest(old.config.endpoint, "/auth/session", {
        method: "DELETE",
        token: old.token,
      }).catch(() => {});
    }
    this.host.dispose();
  }
  private async connect(generation: number, config: RcsSettings): Promise<void> {
    try {
      const key = await this.store.readKey();
      if (!key) throw new Error("AUTH_FAILED");
      const session = await rcsLogin(config.endpoint, key, config.deviceName);
      if (generation !== this.generation) {
        await rcsRequest(config.endpoint, "/auth/session", {
          method: "DELETE",
          token: session.token,
        }).catch(() => {});
        return;
      }
      const socket = new WebSocket(socketUrl(config.endpoint), {
        maxPayload: 16 * 1024 * 1024 + 25,
        handshakeTimeout: 10_000,
        followRedirects: false,
      });
      const link: Link = {
        socket,
        token: session.token,
        config,
        expiry: session.expiresAt,
        generation,
        pong: Date.now(),
      };
      this.link = link;
      const current = () => this.link === link && this.generation === generation;
      socket.on("open", () => {
        if (!current()) return;
        socket.send(JSON.stringify({ type: "auth", token: session.token }));
        socket.send(
          JSON.stringify({
            type: "register",
            deviceId: config.deviceId,
            incarnation: randomUUID(),
            name: config.deviceName,
            bridgeVersion: 1,
            rpcCodec: 1,
            agentWire: 3,
          }),
        );
      });
      socket.on("message", (raw, binary) => {
        if (!current()) return;
        try {
          if (binary) {
            const frame = decodeRcsFrame(new Uint8Array(raw as Buffer));
            this.host.receive(frame.attachmentId, frame.payload);
          } else {
            if (Buffer.byteLength(raw.toString()) > 65536) throw new Error("FRAME_TOO_LARGE");
            const message = rcsControlSchema.parse(JSON.parse(raw.toString()));
            if (message.type === "registered") {
              if (
                message.deviceId !== config.deviceId ||
                message.serverInstanceId !== session.serverInstanceId
              )
                throw new Error("AUTH_FAILED");
              this.status = { state: "online", serverInstanceId: message.serverInstanceId };
              this.attempt = 0;
            } else if (message.type === "pong") link.pong = Date.now();
            else if (
              message.type === "hosts" ||
              message.type === "attach" ||
              message.type === "resource"
            ) {
              const action =
                message.type === "resource"
                  ? this.host.resource(message.attachmentId, message)
                  : message.type === "hosts"
                    ? this.host.listHosts(config.allowedWorkspaces)
                    : this.host
                        .attach(message, config.allowedWorkspaces)
                        .then((capabilities) => ({ capabilities }));
              void action
                .then((result) => {
                  if (current())
                    socket.send(
                      JSON.stringify({
                        type: "reply",
                        requestId: message.requestId,
                        ok: true,
                        result,
                      }),
                    );
                })
                .catch(() => {
                  if (current())
                    socket.send(
                      JSON.stringify({
                        type: "reply",
                        requestId: message.requestId,
                        ok: false,
                        error: "WORKSPACE_SCOPE_STALE",
                      }),
                    );
                });
            } else if (message.type === "activate") this.host.activate(message.attachmentId);
            else if (message.type === "detach") this.host.detach(message.attachmentId);
            else if (message.type === "flow") this.host.flow(message.attachmentId, message.state);
          }
        } catch {
          socket.close(1008, "PROTOCOL_REJECTED");
        }
      });
      let refreshing = false;
      link.timer = setInterval(() => {
        if (!current()) return;
        if (Date.now() - link.pong > 70_000) {
          socket.terminate();
          return;
        }
        if (socket.readyState === WebSocket.OPEN) socket.send('{"type":"ping"}');
        if (Date.now() / 1000 + 300 > link.expiry && !refreshing) {
          refreshing = true;
          void rcsRequest<{ expiresAt: number }>(config.endpoint, "/auth/refresh", {
            method: "POST",
            token: link.token,
          })
            .then((result) => {
              if (current()) link.expiry = result.expiresAt;
            })
            .catch((error) => {
              if (current()) {
                this.status = {
                  state: "auth-failed",
                  error: error instanceof Error ? error.message : "SESSION_EXPIRED",
                };
                socket.close(1008, "SESSION_EXPIRED");
              }
            })
            .finally(() => {
              refreshing = false;
            });
        }
      }, 20_000);
      socket.on("error", () => {});
      socket.once("close", (code, reason) => {
        if (!current()) return;
        this.stopLink();
        if (code === 1008 || this.status.state === "auth-failed") {
          this.status = { state: "auth-failed", error: "CONNECTION_REJECTED" };
          return;
        }
        if (reason.toString() === "SESSION_REVOKED") {
          this.status = { state: "auth-failed", error: "KEY_REVOKED" };
          return;
        }
        this.schedule(generation, config);
      });
    } catch (error) {
      if (generation !== this.generation) return;
      const code =
        error instanceof Error && terminalErrors.has(error.message)
          ? error.message
          : "CONNECTION_FAILED";
      if (terminalErrors.has(code)) {
        this.status = {
          state: code === "VERSION_INCOMPATIBLE" ? "incompatible" : "auth-failed",
          error: code,
        };
        return;
      }
      this.schedule(generation, config);
    }
  }
  private schedule(generation: number, config: RcsSettings): void {
    this.status = { state: "reconnecting", error: "CONNECTION_INTERRUPTED" };
    const delay =
      Math.min(30_000, 1000 * 2 ** Math.min(this.attempt++, 5)) + Math.floor(Math.random() * 500);
    this.retry = setTimeout(() => {
      if (generation === this.generation) void this.connect(generation, config);
    }, delay);
  }
  send(id: string, payload: Uint8Array): void {
    const link = this.link;
    if (!link || link.socket.readyState !== WebSocket.OPEN) return;
    const frame = encodeRcsFrame(id, payload);
    if (link.socket.bufferedAmount + frame.byteLength > RCS_MAX_BUFFER_BYTES) {
      link.socket.close(1013, "FLOW_SATURATED");
      return;
    }
    link.socket.send(frame);
  }
  attachmentClosed(id: string): void {
    if (this.link?.socket.readyState === WebSocket.OPEN)
      this.link.socket.send(JSON.stringify({ type: "detach", attachmentId: id }));
  }
  async validate(input: { endpoint: string; key?: string }): Promise<{ serverInstanceId: string }> {
    const key = input.key || (await this.store.readKey());
    if (!key) throw new Error("AUTH_FAILED");
    const session = await rcsLogin(input.endpoint, key, "ZCode connection validation");
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(socketUrl(input.endpoint), {
          handshakeTimeout: 8000,
          maxPayload: 65536,
          followRedirects: false,
        });
        const timer = setTimeout(() => {
          socket.terminate();
          reject(new Error("RCS_VALIDATION_TIMEOUT"));
        }, 10_000);
        socket.on("open", () => {
          socket.send(JSON.stringify({ type: "auth", token: session.token }));
          socket.send(
            JSON.stringify({
              type: "register",
              deviceId: `validate-${randomUUID()}`,
              incarnation: randomUUID(),
              name: "Connection validation",
              bridgeVersion: 1,
              rpcCodec: 1,
              agentWire: 3,
            }),
          );
        });
        socket.on("message", (data) => {
          let value: unknown;
          try {
            value = JSON.parse(data.toString());
          } catch {
            socket.close(1008, "PROTOCOL_REJECTED");
            return;
          }
          const parsed = rcsControlSchema.safeParse(value);
          if (parsed.success && parsed.data.type === "registered") {
            clearTimeout(timer);
            socket.close();
            resolve();
          }
        });
        socket.on("error", () => {
          clearTimeout(timer);
          reject(new Error("RCS_VALIDATION_FAILED"));
        });
        socket.on("close", () => {
          clearTimeout(timer);
          reject(new Error("RCS_VALIDATION_FAILED"));
        });
      });
      return { serverInstanceId: session.serverInstanceId };
    } finally {
      await rcsRequest(input.endpoint, "/auth/session", {
        method: "DELETE",
        token: session.token,
      }).catch(() => {});
    }
  }
  async listClients(): Promise<RcsClient[]> {
    return this.authenticatedRequest("/clients");
  }
  async revokeClient(id: string): Promise<void> {
    await this.authenticatedRequest(`/clients/${encodeURIComponent(id)}`, "DELETE");
  }
  private async authenticatedRequest<T>(path: string, method = "GET"): Promise<T> {
    if (this.link)
      return rcsRequest<T>(this.link.config.endpoint, path, { method, token: this.link.token });
    const config = await this.store.getSettings();
    const key = await this.store.readKey();
    if (!key) throw new Error("AUTH_FAILED");
    const session = await rcsLogin(config.endpoint, key, config.deviceName);
    try {
      return await rcsRequest<T>(config.endpoint, path, { method, token: session.token });
    } finally {
      await rcsRequest(config.endpoint, "/auth/session", {
        method: "DELETE",
        token: session.token,
      }).catch(() => {});
    }
  }
  dispose(): void {
    this.generation++;
    this.stopLink();
  }
}
