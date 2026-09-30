// Modified by ZCode Feiyu contributors (2026).
/**
 * useSettingService —— 设置服务 hooks
 */
import { useState, useEffect, useCallback } from "react";
import type { AppSettings } from "@zcode/shared";
import { useServices } from "./useServices.js";
import { usePlatform } from "./usePlatform.js";
import { getSettingsStore, refreshSettingsStore, type SettingsSnapshot } from "./settingsStore.js";

/** 获取和更新应用设置 */
export function useSettings() {
  const { settingService } = useServices();
  const platform = usePlatform();
  const settingsStore = getSettingsStore(settingService);
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>(settingsStore.snapshot);

  // 显式刷新（写入之后、收到变更通知之后）必须读到写入之后的值，不能共用更早发起的在途读取。
  const refresh = useCallback(async () => {
    await refreshSettingsStore(settingService, { fresh: true });
  }, [settingService]);

  useEffect(() => {
    const listener = (nextSnapshot: SettingsSnapshot) => {
      setSnapshot(nextSnapshot);
    };

    settingsStore.listeners.add(listener);
    setSnapshot(settingsStore.snapshot);
    // 挂载时的首次读取不依赖任何写入，多个使用方同时挂载共用一次读取即可。
    void refreshSettingsStore(settingService);

    return () => {
      settingsStore.listeners.delete(listener);
    };
  }, [settingService, settingsStore]);

  useEffect(() => {
    return (
      platform.onSettingsChanged?.(() => {
        void refresh();
      }) ?? (() => {})
    );
  }, [platform, refresh]);

  const update = useCallback(
    async (patch: Partial<AppSettings>) => {
      try {
        await settingService.update(patch);
      } catch (error) {
        await refresh();
        throw error;
      }
      platform.syncAppSettings?.(patch);
      if (typeof patch.telemetryReportingEnabled === "boolean") {
        try {
          if (!platform.applyTelemetryConsent) {
            throw new Error("Desktop telemetry consent control is unavailable.");
          }
          await platform.applyTelemetryConsent(patch.telemetryReportingEnabled);
        } finally {
          await refresh();
        }
      } else {
        await refresh();
      }
    },
    [settingService, platform, refresh],
  );

  return {
    settings: snapshot.settings,
    loading: snapshot.loading,
    error: snapshot.error,
    update,
    refresh,
  };
}

/** 最近项目列表的便捷 hook */
export function useRecentProjects() {
  const { settings, loading, update } = useSettings();
  return {
    recentProjects: settings?.recentProjects ?? [],
    loading,
    addProject: async (path: string) => {
      const current = settings?.recentProjects ?? [];
      const updated = [path, ...current.filter((p) => p !== path)].slice(0, 10);
      await update({ recentProjects: updated });
    },
  };
}
