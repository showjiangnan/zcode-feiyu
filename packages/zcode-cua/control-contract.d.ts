// Modified by ZCode Feiyu contributors (2026).
export interface ControlContext {
  runtimeScope: "main";
  sessionId: string;
  turnId: string;
  workspaceKey: string;
  workspacePath?: string;
  workspaceIdentity?: string;
}
export interface ControlApp {
  appId: string;
  appKey: string;
  displayName: string;
  path?: string;
  fileIdentity?: string;
}
export interface ControlSource {
  id: string;
  context: ControlContext;
  sessionId: string;
  turnId: string;
  workspaceKey: string;
  app: ControlApp;
  targetId: string;
  windowId: number;
  title: string;
  phase:
    | "busy"
    | "paused"
    | "ready"
    | "observing"
    | "stopping"
    | "stopped"
    | "unknown"
    | "unavailable";
  live: boolean;
  capturedAt?: number;
  frameSequence?: number;
  stopRevision?: number;
  stopOrigin?:
    | "native"
    | "external-input"
    | "system-or-unclassified"
    | "trusted-ui"
    | "model"
    | "runtime";
  reason?: string;
  image?: { data: string; mimeType: string; width: number; height: number; imageId: string };
  channels?: Record<string, { status: string; reason?: string }>;
}
export interface ControlSnapshot {
  schemaVersion: 1;
  generation?: string;
  revision: number;
  sources: ControlSource[];
  approvals: { id: string; context: ControlContext; app: ControlApp; createdAt: number }[];
}
export interface ControlPresentation {
  captionSize: number;
  foreground: [number, number, number, number];
  background: [number, number, number, number];
  border: [number, number, number, number];
  accent: [number, number, number, number];
  labels: Record<"observing" | "active" | "waiting" | "paused", string>;
}
export interface ControlUiRequest {
  credential: string;
  workspacePath: string;
  workspaceIdentity?: string;
  action:
    | "snapshot"
    | "approve"
    | "stop"
    | "resume"
    | "visibility"
    | "revoke-grants"
    | "presentation";
  presentation?: ControlPresentation;
  approvalId?: string;
  allowed?: boolean;
  scope?: "turn" | "workspace";
  sourceId?: string;
  stopRevision?: number;
  stopOrigin?:
    | "native"
    | "external-input"
    | "system-or-unclassified"
    | "trusted-ui"
    | "model"
    | "runtime";
  sourceIds?: string[];
  subscriber?: string;
}
export declare function isControlSnapshot(value: unknown): value is ControlSnapshot;
export declare function validateControlPresentation(value: unknown): ControlPresentation;
