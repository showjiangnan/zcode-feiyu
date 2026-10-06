import { z } from "zod";

export const RCS_BRIDGE_VERSION = 1;
export const RCS_RPC_CODEC_VERSION = 1;
export const RCS_AGENT_WIRE_VERSION = 3;
export const RCS_FRAME_HEADER_BYTES = 25;
export const RCS_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const RCS_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export const rcsConfigSchema = z
  .object({
    enabled: z.boolean(),
    endpoint: z.string().max(2048),
    deviceName: z.string().trim().min(1).max(80),
    allowedWorkspaces: z.array(z.string().min(1).max(4096)).max(128),
  })
  .strict();
export type RcsConfig = z.infer<typeof rcsConfigSchema>;
export interface RcsSettings extends RcsConfig {
  hasKey: boolean;
  deviceId: string;
  revision: number;
}
export const rcsSaveSchema = rcsConfigSchema
  .extend({
    key: z.string().min(32).max(512).optional(),
    clearKey: z.boolean().optional(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export type RcsSave = z.infer<typeof rcsSaveSchema>;
export type RcsConnectionState =
  | "disabled"
  | "connecting"
  | "online"
  | "reconnecting"
  | "auth-failed"
  | "incompatible"
  | "error";
export interface RcsStatus {
  state: RcsConnectionState;
  error?: string;
  serverInstanceId?: string;
}
export const rcsWorkspaceSchema = z
  .object({
    handle: z.string().min(1).max(128),
    name: z.string().max(256),
    workspacePath: z.string().min(1).max(4096),
    workspaceIdentity: z.string().min(1).max(4096).nullable().optional(),
    remoteSessionId: z.string().min(1).max(128).nullable().optional(),
  })
  .strict();
export type RcsWorkspace = z.infer<typeof rcsWorkspaceSchema>;
export const rcsHostSchema = z
  .object({
    id: z.string().min(1).max(128),
    generation: z.string().min(1).max(128),
    name: z.string().max(256),
    workspaces: z.array(rcsWorkspaceSchema).max(128),
  })
  .strict();
export type RcsHost = z.infer<typeof rcsHostSchema>;
export const rcsGrantSchema = z
  .object({
    workspacePath: z.string().min(1).max(4096),
    workspaceIdentity: z.string().min(1).max(4096).optional(),
    remoteSessionId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type RcsGrant = z.infer<typeof rcsGrantSchema>;
export interface RcsClient {
  id: string;
  name: string;
  expiresAt: number;
  createdAt: number;
}
export interface RcsPlatform {
  getSettings(): Promise<RcsSettings>;
  saveSettings(input: RcsSave): Promise<RcsSettings>;
  getStatus(): Promise<RcsStatus>;
  validate(input: { endpoint: string; key?: string }): Promise<{ serverInstanceId: string }>;
  reconnect(): Promise<void>;
  listHosts(): Promise<RcsHost[]>;
  listClients(): Promise<RcsClient[]>;
  revokeClient(id: string): Promise<void>;
}
export interface RcsDevice {
  id: string;
  name: string;
  incarnation: string;
  online: boolean;
}
export interface RcsCapabilities {
  bridgeVersion: 1;
  rpcCodec: 1;
  agentWire: 3;
  services: Record<string, { methods: readonly string[]; events: readonly string[] }>;
  workspace: RcsGrant;
  nativeDesktop: false;
}
export interface RcsAttachment {
  id: string;
  deviceId: string;
  hostId: string;
  hostGeneration: string;
  workspaceHandle: string;
  capabilities: RcsCapabilities;
  state: "ready" | "connected";
}

export function normalizeRcsEndpoint(value: string): string {
  const url = new URL(value.trim());
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("RCS_ENDPOINT_HTTPS_REQUIRED");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("RCS_ENDPOINT_ORIGIN_REQUIRED");
  }
  return url.origin;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function encodeRcsFrame(id: string, payload: Uint8Array): Uint8Array {
  if (!uuidPattern.test(id) || payload.byteLength > RCS_MAX_FRAME_BYTES)
    throw new Error("RCS_FRAME_INVALID");
  const frame = new Uint8Array(RCS_FRAME_HEADER_BYTES + payload.byteLength);
  frame.set([90, 82, 67, 83, 1]);
  const hex = id.replaceAll("-", "");
  for (let i = 0; i < 16; i++) frame[5 + i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  new DataView(frame.buffer).setUint32(21, payload.byteLength);
  frame.set(payload, RCS_FRAME_HEADER_BYTES);
  return frame;
}
export function decodeRcsFrame(frame: Uint8Array): { attachmentId: string; payload: Uint8Array } {
  if (
    frame.byteLength < RCS_FRAME_HEADER_BYTES ||
    frame.byteLength > RCS_MAX_FRAME_BYTES + RCS_FRAME_HEADER_BYTES ||
    ![90, 82, 67, 83, 1].every((n, i) => frame[i] === n)
  )
    throw new Error("RCS_FRAME_INVALID");
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(21);
  if (length !== frame.byteLength - RCS_FRAME_HEADER_BYTES) throw new Error("RCS_FRAME_INVALID");
  const hex = Array.from(frame.subarray(5, 21), (n) => n.toString(16).padStart(2, "0")).join("");
  return {
    attachmentId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    payload: frame.subarray(RCS_FRAME_HEADER_BYTES),
  };
}

export const rcsControlSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("registered"),
      deviceId: z.string(),
      incarnation: z.string(),
      serverInstanceId: z.string(),
    })
    .strict(),
  z.object({ type: z.literal("pong") }).strict(),
  z.object({ type: z.literal("hosts"), requestId: z.string().max(128) }).strict(),
  z
    .object({
      type: z.literal("attach"),
      requestId: z.string().max(128),
      attachmentId: z.string().uuid(),
      hostId: z.string().max(128),
      hostGeneration: z.string().max(128),
      workspaceHandle: z.string().max(128),
    })
    .strict(),
  z.object({ type: z.literal("activate"), attachmentId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("detach"), attachmentId: z.string().uuid() }).strict(),
  z
    .object({
      type: z.literal("flow"),
      attachmentId: z.string().uuid(),
      state: z.enum(["saturated", "drained"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("resource"),
      requestId: z.string().max(128),
      attachmentId: z.string().uuid(),
      operation: z.enum(["stat", "read"]),
      expectedSize: z.number().int().nonnegative().optional(),
      expectedMtimeMs: z.number().nonnegative().optional(),
      path: z.string().min(1).max(4096),
      offset: z.number().int().nonnegative().optional(),
      length: z
        .number()
        .int()
        .positive()
        .max(512 * 1024)
        .optional(),
    })
    .strict(),
]);
export type RcsControl = z.infer<typeof rcsControlSchema>;
