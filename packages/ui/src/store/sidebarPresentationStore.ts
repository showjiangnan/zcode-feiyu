// Modified by ZCode Feiyu contributors (2026).
import { create } from "zustand";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { getSafeLocalStorage, type BrowserStorageLike } from "@/lib/browserEnvironment.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  emptySidebarPresentation,
  parseSidebarPresentation,
  SIDEBAR_PRESENTATION_KEY,
  sidebarTaskKey,
  type SidebarPresentation,
} from "@/lib/sidebarPresentation.js";

type TaskIdentity = Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">;
interface SidebarPresentationState {
  preferences: SidebarPresentation;
  renameProject: (workspaceKey: string, label: string) => void;
  pinProject: (workspaceKey: string, pinned: boolean) => void;
  forgetProject: (workspaceKey: string) => void;
  touchProject: (workspacePath: string, workspaceIdentity?: string) => void;
  recordTaskPin: (task: TaskIdentity, pinned: boolean) => void;
  seedTaskPins: (tasks: TaskIdentity[]) => void;
  receiveStorage: (raw: string | null) => void;
}

export function createSidebarPresentationStore(
  storage: BrowserStorageLike | null = getSafeLocalStorage(),
  now: () => number = Date.now,
) {
  function read(): SidebarPresentation | null {
    try {
      const raw = storage?.getItem(SIDEBAR_PRESENTATION_KEY);
      return raw ? parseSidebarPresentation(raw) : null;
    } catch {
      return null;
    }
  }
  return create<SidebarPresentationState>()((set, get) => {
    let storageWriteFailed = false;
    const commit = (mutate: (next: SidebarPresentation, timestamp: number) => boolean | void) => {
      const current = (storageWriteFailed ? null : read()) ?? get().preferences;
      const next = {
        ...current,
        projects: { ...current.projects },
        taskPinOrder: { ...current.taskPinOrder },
      };
      const timestamp = Math.max(now(), current.clock + 1);
      if (mutate(next, timestamp) === false) return;
      next.clock = timestamp;
      try {
        storage?.setItem(SIDEBAR_PRESENTATION_KEY, JSON.stringify(next));
        storageWriteFailed = false;
      } catch {
        // 隐私模式或磁盘不可写时仍保留当前窗口的可用导航状态。
        storageWriteFailed = true;
      }
      set({ preferences: next });
    };
    return {
      preferences: read() ?? emptySidebarPresentation(),
      renameProject(key, label) {
        if (!label.trim()) return;
        commit((next) => {
          next.projects[key] = { ...next.projects[key], label: label.trim() };
        });
      },
      pinProject(key, pinned) {
        commit((next, timestamp) => {
          const { pinnedAt: previous, ...rest } = next.projects[key] ?? {};
          next.projects[key] = pinned ? { ...rest, pinnedAt: previous ?? timestamp } : rest;
        });
      },
      forgetProject(key) {
        commit((next) => {
          delete next.projects[key];
        });
      },
      touchProject(path, identity) {
        const key = buildTaskWorkspaceKey(path, identity);
        commit((next, timestamp) => {
          next.projects[key] = { ...next.projects[key], interactedAt: timestamp };
        });
      },
      recordTaskPin(task, pinned) {
        commit((next, timestamp) => {
          const key = sidebarTaskKey(task);
          if (pinned) next.taskPinOrder[key] = timestamp;
          else delete next.taskPinOrder[key];
        });
      },
      seedTaskPins(tasks) {
        commit((next) => {
          const missing = tasks.filter(
            (task) => next.taskPinOrder[sidebarTaskKey(task)] === undefined,
          );
          if (!missing.length) return false;
          // 旧协议没有 pinnedAt；冻结首次观察顺序，不把 updatedAt 当成置顶时间。
          let legacyOrder = Math.min(0, ...Object.values(next.taskPinOrder)) - 1;
          for (const task of missing) next.taskPinOrder[sidebarTaskKey(task)] = legacyOrder--;
        });
      },
      receiveStorage(raw) {
        set({ preferences: parseSidebarPresentation(raw) });
      },
    };
  });
}

export const useSidebarPresentationStore = createSidebarPresentationStore();
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === SIDEBAR_PRESENTATION_KEY || event.key === null) {
      // 只消费其他窗口事件，不回写，避免 storage 广播回环。
      useSidebarPresentationStore.getState().receiveStorage(event.newValue);
    }
  });
}
