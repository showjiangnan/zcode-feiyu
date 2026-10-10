// Modified by ZCode Feiyu contributors (2026).
import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildTaskWorkspaceKey } from "./taskQueryCache.js";

export interface SidebarProjectPreference {
  label?: string;
  pinnedAt?: number;
  interactedAt?: number;
}

export interface SidebarPresentation {
  version: 1;
  clock: number;
  projects: Record<string, SidebarProjectPreference>;
  taskPinOrder: Record<string, number>;
}

export const SIDEBAR_PRESENTATION_KEY = "zcode-sidebar-presentation-v1";
export const emptySidebarPresentation = (): SidebarPresentation => ({
  version: 1,
  clock: 0,
  projects: {},
  taskPinOrder: {},
});

const validTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

export function parseSidebarPresentation(raw: string | null): SidebarPresentation {
  const result = emptySidebarPresentation();
  if (!raw) return result;
  try {
    const data = JSON.parse(raw);
    if (data?.version !== 1) return result;
    if (validTime(data.clock) && data.clock >= 0) result.clock = data.clock;
    for (const [key, value] of Object.entries(data.projects ?? {})) {
      if (!value || typeof value !== "object") continue;
      const entry = value as SidebarProjectPreference;
      const label = typeof entry.label === "string" ? entry.label.trim() : "";
      result.projects[key] = {
        ...(label ? { label } : {}),
        ...(validTime(entry.pinnedAt) && entry.pinnedAt > 0 ? { pinnedAt: entry.pinnedAt } : {}),
        ...(validTime(entry.interactedAt) && entry.interactedAt > 0
          ? { interactedAt: entry.interactedAt }
          : {}),
      };
      result.clock = Math.max(
        result.clock,
        result.projects[key].pinnedAt ?? 0,
        result.projects[key].interactedAt ?? 0,
      );
    }
    for (const [key, value] of Object.entries(data.taskPinOrder ?? {})) {
      if (validTime(value)) {
        result.taskPinOrder[key] = value;
        result.clock = Math.max(result.clock, value);
      }
    }
  } catch {
    // 损坏的客户端偏好不能阻断侧栏和会话导航。
  }
  return result;
}

export function sidebarTaskKey(
  task: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
): string {
  return JSON.stringify([
    buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
    task.taskId,
  ]);
}

export function projectNameMatches(name: string, query: string): boolean {
  const normalize = (text: string) =>
    text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  const candidate = normalize(name);
  const terms = normalize(query).trim().split(/\s+/u);
  return terms.every((term) => {
    let cursor = 0;
    for (const char of term) {
      cursor = candidate.indexOf(char, cursor);
      if (cursor < 0) return false;
      cursor++;
    }
    return true;
  });
}

export function sortSidebarProjects<
  T extends { workspacePath: string; workspaceIdentity?: string },
>(
  projects: T[],
  preferences: SidebarPresentation["projects"],
  field: "interactedAt" | "pinnedAt",
): T[] {
  // 不用会话 updatedAt：流式输出和后台任务不是用户导航操作。
  return [...projects].sort(
    (left, right) =>
      (preferences[buildTaskWorkspaceKey(right.workspacePath, right.workspaceIdentity)]?.[field] ??
        0) -
      (preferences[buildTaskWorkspaceKey(left.workspacePath, left.workspaceIdentity)]?.[field] ??
        0),
  );
}
