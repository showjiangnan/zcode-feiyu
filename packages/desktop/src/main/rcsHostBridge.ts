import { ChannelClient, Emitter, VSBuffer } from "@zcode/rpc";
import { randomUUID } from "node:crypto";
import { MessageChannelMain, type MessagePortMain, type UtilityProcess } from "electron";
import {
  HostMessageTypes,
  rcsWorkspaceSchema,
  type RcsHost,
  type RcsWorkspace,
  type RcsCapabilities,
  type RcsGrant,
} from "@zcode/shared";

interface Entry {
  grant: RcsGrant;
  resource?: { port: MessagePortMain; client: ChannelClient; dispose(): void };
  child: UtilityProcess;
  port: MessagePortMain;
  active: boolean;
  initial: Uint8Array[];
  bytes: number;
  capabilities: RcsCapabilities;
}
export class RcsHostBridge {
  private generations = new WeakMap<UtilityProcess, string>();
  private attachments = new Map<string, Entry>();
  constructor(
    private readonly options: {
      hosts: () => Map<number, UtilityProcess>;
      send: (id: string, payload: Uint8Array) => void;
      closed: (id: string) => void;
    },
  ) {}
  private generation(child: UtilityProcess): string {
    let value = this.generations.get(child);
    if (!value) {
      value = randomUUID();
      this.generations.set(child, value);
    }
    return value;
  }
  private readDirectory(child: UtilityProcess): Promise<RcsWorkspace[]> {
    return new Promise((resolve, reject) => {
      const { port1, port2 } = new MessageChannelMain();
      let replied = false;
      const timer = setTimeout(() => {
        port1.close();
        reject(new Error("HOST_TIMEOUT"));
      }, 10_000);
      port1.once("message", (event) => {
        replied = true;
        clearTimeout(timer);
        port1.close();
        try {
          if (!event.data?.ok) throw new Error(String(event.data.error || "HOST_NOT_READY"));
          resolve(rcsWorkspaceSchema.array().parse(event.data.workspaces));
        } catch (error) {
          reject(error);
        }
      });
      port1.once("close", () => {
        clearTimeout(timer);
        if (!replied) reject(new Error("HOST_GONE"));
      });
      port1.start();
      child.postMessage({ type: "rcs-directory" }, [port2]);
    });
  }
  async listHosts(allowedWorkspaces?: readonly string[]): Promise<RcsHost[]> {
    const items = await Promise.all(
      [...this.options.hosts()].map(async ([id, child]) => {
        try {
          const workspaces = await this.readDirectory(child);
          if (this.options.hosts().get(id) !== child) return null;
          return {
            id: String(id),
            generation: this.generation(child),
            name: `ZCode ${id}`,
            workspaces: workspaces.filter(
              (item) =>
                !allowedWorkspaces ||
                allowedWorkspaces.includes(item.workspaceIdentity?.trim() || item.workspacePath),
            ),
          };
        } catch (error) {
          if (this.options.hosts().get(id) !== child) return null;
          throw error;
        }
      }),
    );
    return items.filter((item): item is RcsHost => item !== null);
  }
  async attach(
    params: {
      attachmentId: string;
      hostId: string;
      hostGeneration: string;
      workspaceHandle: string;
    },
    allowed: readonly string[],
  ): Promise<RcsCapabilities> {
    const child = this.options.hosts().get(Number(params.hostId));
    if (!child || this.generation(child) !== params.hostGeneration) throw new Error("HOST_GONE");
    const workspace = (await this.readDirectory(child)).find(
      (item) =>
        item.handle === params.workspaceHandle &&
        allowed.includes(item.workspaceIdentity?.trim() || item.workspacePath),
    );
    if (!workspace || this.options.hosts().get(Number(params.hostId)) !== child)
      throw new Error("WORKSPACE_SCOPE_STALE");
    const grant: RcsGrant = {
      workspacePath: workspace.workspacePath,
      ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
      ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
    };
    return new Promise((resolve, reject) => {
      const { port1, port2 } = new MessageChannelMain();
      const entry: Entry = {
        grant,
        child,
        port: port1,
        active: false,
        initial: [],
        bytes: 0,
        capabilities: undefined!,
      };
      this.detach(params.attachmentId);
      this.attachments.set(params.attachmentId, entry);
      const timer = setTimeout(() => {
        this.detach(params.attachmentId);
        reject(new Error("HOST_TIMEOUT"));
      }, 15_000);
      port1.on("message", (event) => {
        if (this.attachments.get(params.attachmentId) !== entry) return;
        const data = event.data as unknown;
        if (data instanceof Uint8Array) {
          if (entry.active) this.options.send(params.attachmentId, data);
          else if (entry.bytes + data.byteLength <= 1024 * 1024) {
            entry.initial.push(data);
            entry.bytes += data.byteLength;
          } else {
            this.detach(params.attachmentId);
            reject(new Error("FLOW_SATURATED"));
          }
        } else if ((data as { type?: string })?.type === "rcs-ready") {
          clearTimeout(timer);
          entry.capabilities = (data as { capabilities: RcsCapabilities }).capabilities;
          resolve(entry.capabilities);
        } else if ((data as { type?: string })?.type === "rcs-error") {
          clearTimeout(timer);
          this.detach(params.attachmentId);
          reject(new Error("WORKSPACE_SCOPE_STALE"));
        }
      });
      port1.once("close", () => {
        clearTimeout(timer);
        reject(new Error("HOST_GONE"));
        if (this.attachments.get(params.attachmentId) === entry) {
          this.attachments.delete(params.attachmentId);
          this.options.closed(params.attachmentId);
        }
      });
      port1.start();
      child.postMessage(
        {
          type: HostMessageTypes.AttachServicePort,
          requestId: randomUUID(),
          attachmentId: params.attachmentId,
          clientMode: "web-remote-replayable",
          scope: grant.remoteSessionId ? { kind: "remote", ...grant } : { kind: "local" },
          rcsGrant: grant,
        },
        [port2],
      );
    });
  }
  async resource(
    id: string,
    input: {
      operation: "stat" | "read";
      path: string;
      offset?: number;
      length?: number;
      expectedSize?: number;
      expectedMtimeMs?: number;
    },
  ): Promise<unknown> {
    const entry = this.attachments.get(id);
    if (!entry?.active) throw new Error("ATTACHMENT_NOT_ACTIVE");
    if (!entry.resource) {
      const { port1, port2 } = new MessageChannelMain();
      const emitter = new Emitter<VSBuffer>();
      const client = new ChannelClient({
        onMessage: emitter.event,
        send: (buffer) => port1.postMessage(buffer.buffer),
      });
      port1.on("message", (event) => {
        if (event.data instanceof Uint8Array) emitter.fire(VSBuffer.wrap(event.data));
      });
      port1.start();
      const resourceId = `${id}-resource`;
      entry.resource = {
        port: port1,
        client,
        dispose() {
          client.dispose(new Error("DEVICE_OFFLINE"));
          emitter.dispose();
          port1.close();
          entry.child.postMessage({
            type: HostMessageTypes.DetachServicePort,
            attachmentId: resourceId,
          });
        },
      };
      port1.once("close", () => client.dispose(new Error("HOST_GONE")));
      entry.child.postMessage(
        {
          type: HostMessageTypes.AttachServicePort,
          requestId: randomUUID(),
          attachmentId: resourceId,
          clientMode: "web-remote-replayable",
          scope: entry.grant.remoteSessionId
            ? { kind: "remote", ...entry.grant }
            : { kind: "local" },
          rcsGrant: entry.grant,
        },
        [port2],
      );
    }
    const resource = entry.resource;
    const channel = resource.client.getChannel("file");
    const result = await channel.call(input.operation === "stat" ? "stat" : "readFileRange", [
      {
        path: input.path,
        ...(input.operation === "read"
          ? {
              offset: input.offset ?? 0,
              length: Math.min(input.length ?? 512 * 1024, 512 * 1024),
              expectedSize: input.expectedSize,
              expectedMtimeMs: input.expectedMtimeMs,
            }
          : {}),
      },
    ]);
    if (this.attachments.get(id) !== entry) throw new Error("HOST_GONE");
    return input.operation === "read"
      ? { dataBase64: Buffer.from(result as Uint8Array).toString("base64") }
      : result;
  }
  activate(id: string): void {
    const entry = this.attachments.get(id);
    if (!entry) return;
    entry.active = true;
    for (const payload of entry.initial) this.options.send(id, payload);
    entry.initial = [];
    entry.bytes = 0;
  }
  receive(id: string, payload: Uint8Array): void {
    const entry = this.attachments.get(id);
    if (!entry?.active) throw new Error("ATTACHMENT_NOT_ACTIVE");
    entry.port.postMessage(payload);
  }
  flow(id: string, state: "saturated" | "drained"): void {
    this.attachments.get(id)?.port.postMessage({ __zcodeRpcControl: "connection-flow-v1", state });
  }
  detach(id: string): void {
    const entry = this.attachments.get(id);
    if (!entry) return;
    this.attachments.delete(id);
    entry.resource?.dispose();
    entry.port.close();
    entry.child.postMessage({ type: HostMessageTypes.DetachServicePort, attachmentId: id });
  }
  dispose(): void {
    for (const id of this.attachments.keys()) this.detach(id);
  }
}
