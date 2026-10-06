import {
  ChannelClient,
  Emitter,
  VSBuffer,
  type IMessagePassingProtocol,
  type IChannel,
  Event,
} from "@zcode/rpc";
import {
  getMediaPreviewFormat,
  decodeRcsFrame,
  encodeRcsFrame,
  RCS_MAX_BUFFER_BYTES,
  RCS_SERVICE_MANIFEST,
  type RcsAttachment,
} from "@zcode/shared";
import { createRcsTerminalService } from "./rcsTerminal.js";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";
import type { RcsHttpClient } from "./rcsHttpClient.js";

export interface RcsSocket {
  readyState: number;
  bufferedAmount: number;
  binaryType: string;
  send(value: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: string,
    callback: (event: { data?: unknown; code?: number; reason?: string }) => void,
  ): void;
  removeEventListener(
    type: string,
    callback: (event: { data?: unknown; code?: number; reason?: string }) => void,
  ): void;
}
export type RcsSocketFactory = (url: string) => RcsSocket;
export interface RcsPublicRequest {
  service: string;
  method: string;
  args?: unknown[];
}
export interface RcsPublicSubscription {
  service: string;
  event: string;
  arg?: unknown;
}

/** 公共请求在客户端 codec 编码，relay 只转发独立二进制消息；不需要 DOM。 */
export class RcsRpcConnection {
  readonly services: RemoteServiceAccess;
  readonly closed: Event<{ code: number; reason: string }>;
  private readonly message = new Emitter<VSBuffer>();
  private readonly closeEvent = new Emitter<{ code: number; reason: string }>();
  private readonly client: ChannelClient;
  private heartbeat?: ReturnType<typeof setInterval>;
  private disposed = false;
  private onMessage: (event: { data?: unknown }) => void;
  private onClose: (event: { code?: number; reason?: string }) => void;
  readonly ready: Promise<void>;
  constructor(
    readonly attachment: RcsAttachment,
    private readonly socket: RcsSocket,
    http?: RcsHttpClient,
  ) {
    this.closed = this.closeEvent.event;
    socket.binaryType = "arraybuffer";
    const protocol: IMessagePassingProtocol = {
      onMessage: this.message.event,
      send: (value) => {
        if (this.disposed || socket.readyState !== 1) throw new Error("DEVICE_OFFLINE");
        const data = encodeRcsFrame(attachment.id, value.buffer);
        if (socket.bufferedAmount + data.byteLength > RCS_MAX_BUFFER_BYTES) {
          this.dispose();
          throw new Error("FLOW_SATURATED");
        }
        socket.send(data as Uint8Array<ArrayBuffer>);
      },
    };
    this.client = new ChannelClient(protocol);
    this.services = new RemoteServiceAccess({
      getChannel: <T extends IChannel>(name: string): T => {
        const channel = this.client.getChannel(name);
        const capability = attachment.capabilities.services[name];
        const authorized: IChannel = {
          call: (method, args, token) =>
            capability?.methods.includes(method)
              ? channel.call(method, args, token)
              : Promise.reject(new Error("CAPABILITY_DENIED")),
          // 可选内部事件在代理上仍是函数；不支持的订阅不得发送到 Host。
          listen: (event, arg) =>
            capability?.events.includes(event) ? channel.listen(event, arg) : Event.None,
        };
        return authorized as T;
      },
    });
    Object.assign(this.services, {
      terminalService: createRcsTerminalService(this.services.terminalService),
    });
    if (http)
      Object.assign(this.services, {
        mediaPreviewService: {
          prepare: async ({ path, expectedKind }: { path: string; expectedKind: string }) => {
            const format = getMediaPreviewFormat(path);
            if (!format || format.kind !== expectedKind)
              throw new Error("RESOURCE_FORMAT_UNSUPPORTED");
            const stat = await this.services.fileService.stat({ path });
            if (stat.type !== "file" || stat.size === undefined)
              throw new Error("RESOURCE_NOT_FOUND");
            return {
              kind: "host-range-url",
              mediaType: format.mediaType,
              path,
              previewId: path,
              size: stat.size,
              url: http.resourceUrl(attachment.id, path),
              urlExpiresAt: Date.now() + 60 * 60 * 1000,
            };
          },
          refreshPlaybackUrl: async ({ previewId }: { previewId: string }) => ({
            url: http.resourceUrl(attachment.id, previewId),
            expiresAt: Date.now() + 60 * 60 * 1000,
          }),
          release: async () => {},
        },
      });
    this.onMessage = (event) => {
      if (typeof event.data === "string") return;
      try {
        const bytes =
          event.data instanceof Uint8Array ? event.data : new Uint8Array(event.data as ArrayBuffer);
        const frame = decodeRcsFrame(bytes);
        if (frame.attachmentId !== attachment.id) throw new Error("CAPABILITY_DENIED");
        this.message.fire(VSBuffer.wrap(frame.payload));
      } catch {
        socket.close(1008, "PROTOCOL_REJECTED");
      }
    };
    this.onClose = (event) => {
      this.dispose(false, {
        code: event.code ?? 1006,
        reason: event.reason ?? "CONNECTION_INTERRUPTED",
      });
    };
    socket.addEventListener("message", this.onMessage);
    socket.addEventListener("close", this.onClose);
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.dispose();
        reject(new Error("HOST_TIMEOUT"));
      }, 20_000);
      const readyListener = this.client.onDidInitialize(() => {
        clearTimeout(timeout);
        closeListener.dispose();
        readyListener.dispose();
        resolve();
      });
      const closeListener = this.closed(() => {
        clearTimeout(timeout);
        readyListener.dispose();
        closeListener.dispose();
        reject(new Error("DEVICE_OFFLINE"));
      });
    });
  }
  static async connect(
    http: RcsHttpClient,
    attachment: RcsAttachment,
    socketFactory: RcsSocketFactory = (url) => new WebSocket(url) as unknown as RcsSocket,
  ): Promise<RcsRpcConnection> {
    const ticket = await http.socketTicket(attachment.id);
    const socket = socketFactory(`${http.endpoint.replace(/^http/, "ws")}/ws/rcs/v1/client`);
    const connection = new RcsRpcConnection(attachment, socket, http);
    const open = () => {
      socket.send(JSON.stringify({ type: "ticket", ticket: ticket.ticket }));
    };
    socket.addEventListener("open", open);
    if (socket.readyState === 1) open();
    try {
      await connection.ready;
    } catch (cause) {
      connection.dispose();
      throw cause;
    } finally {
      socket.removeEventListener("open", open);
    }
    connection.heartbeat = setInterval(() => {
      if (socket.readyState === 1) socket.send('{"type":"ping"}');
      void http.refreshIfNeeded().catch(() => socket.close(1008, "SESSION_EXPIRED"));
    }, 20_000);
    return connection;
  }
  call<T = unknown>(request: RcsPublicRequest): Promise<T> {
    if (
      !this.attachment.capabilities.services[request.service]?.methods.includes(request.method) ||
      !RCS_SERVICE_MANIFEST[request.service]?.methods.includes(request.method)
    )
      return Promise.reject(new Error("CAPABILITY_DENIED"));
    return this.client.getChannel(request.service).call<T>(request.method, request.args ?? []);
  }
  subscribe<T = unknown>(
    request: RcsPublicSubscription,
    listener: (event: T) => void,
  ): { dispose(): void } {
    if (
      !this.attachment.capabilities.services[request.service]?.events.includes(request.event) ||
      !RCS_SERVICE_MANIFEST[request.service]?.events.includes(request.event)
    )
      throw new Error("CAPABILITY_DENIED");
    return this.client.getChannel(request.service).listen<T>(request.event, request.arg)(listener);
  }
  dispose(closeSocket = true, outcome = { code: 1000, reason: "CLIENT_DETACHED" }): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeEvent.fire(outcome);
    this.closeEvent.dispose();
    clearInterval(this.heartbeat);
    this.client.dispose(new Error("DEVICE_OFFLINE"));
    this.socket.removeEventListener("message", this.onMessage);
    this.socket.removeEventListener("close", this.onClose);
    this.message.dispose();
    if (closeSocket) this.socket.close(1000, "CLIENT_DETACHED");
  }
}
