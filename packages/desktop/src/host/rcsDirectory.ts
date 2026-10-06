import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  AppSettings,
  RcsGrant,
  RcsWorkspace,
  WindowHostRemoteWorkspaceDescriptor,
} from "@zcode/shared";

interface Workspace {
  workspacePath: string;
  workspaceIdentity?: string;
}
export function rcsWorkspaceKey(value: Workspace): string {
  return value.workspaceIdentity?.trim() || value.workspacePath;
}

export async function readRcsWorkspaces(options: {
  settings: () => Promise<AppSettings>;
  registered: () => Workspace[];
  remotes: () => Array<
    WindowHostRemoteWorkspaceDescriptor & { sourceAvailability: "online" | "offline" }
  >;
}): Promise<RcsWorkspace[]> {
  const settings = await options.settings();
  const remoteItems = options.remotes();
  const remoteKeys = new Set(
    remoteItems
      .filter((item) => item.workspacePath)
      .map((item) => rcsWorkspaceKey(item as Workspace)),
  );
  const candidates: Workspace[] = [
    ...options.registered().filter((item) => !remoteKeys.has(rcsWorkspaceKey(item))),
    ...(settings.recentProjects ?? []).map((workspacePath) => ({ workspacePath })),
    ...(settings.lastWorkspaceSession ?? [])
      .filter((s) => s.kind === "local")
      .map((s) => ({ workspacePath: s.workspacePath })),
  ];
  const unique = new Map<string, RcsGrant>();
  // Controller 内部 scope 含 kind 等字段，公开目录必须显式投影，不能展开内部对象。
  for (const item of candidates)
    unique.set(rcsWorkspaceKey(item), {
      workspacePath: item.workspacePath,
      ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
    });
  for (const item of remoteItems)
    if (item.sourceAvailability === "online" && item.workspacePath && item.workspaceIdentity)
      unique.set(rcsWorkspaceKey(item as Workspace), {
        workspacePath: item.workspacePath,
        workspaceIdentity: item.workspaceIdentity,
        remoteSessionId: item.remoteSessionId,
      });
  return [...unique.values()].slice(0, 128).map((item) => ({
    ...item,
    name: basename(item.workspacePath) || item.workspacePath,
    handle: createHash("sha256")
      .update(`${rcsWorkspaceKey(item)}\0${item.remoteSessionId ?? "local"}`)
      .digest("hex"),
  }));
}

export function assertRcsGrantCurrent(grant: RcsGrant, workspaces: RcsWorkspace[]): void {
  if (
    !workspaces.some(
      (item) =>
        item.workspacePath === grant.workspacePath &&
        (item.workspaceIdentity ?? undefined) === grant.workspaceIdentity &&
        (item.remoteSessionId ?? undefined) === grant.remoteSessionId,
    )
  )
    throw new Error("WORKSPACE_SCOPE_STALE");
}
