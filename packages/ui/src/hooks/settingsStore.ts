// Modified by ZCode Feiyu contributors (2026).
import type { AppSettings } from "@zcode/shared";
import type { ISettingService } from "@zcode/services";

export type SettingsSnapshot = {
  settings: AppSettings | null;
  loading: boolean;
  error: unknown | null;
};

interface InflightRead {
  generation: number;
  promise: Promise<void>;
}

export interface SettingsStore {
  snapshot: SettingsSnapshot;
  inflight: InflightRead | null;
  /** 每次要求「读取必须晚于此刻发起」的刷新都会推进；发起时代数已落后的读取，其结果作废。 */
  generation: number;
  listeners: Set<(snapshot: SettingsSnapshot) => void>;
}

function createSettingsStore(): SettingsStore {
  return {
    snapshot: { settings: null, loading: true, error: null },
    inflight: null,
    generation: 0,
    listeners: new Set(),
  };
}

// SettingsPage 外层与模型配置页内层可能分别绑定 Local/Remote Service；
// 共享一份 snapshot/inflight 会让一次 Environment 的刷新结果覆盖另一份事实源。
// 按 Service 实例隔离 store，保持同一 Environment 内的组件共享，同时阻断跨 Environment 串写。
const stores = new WeakMap<object, SettingsStore>();
const unavailableSettingsStore = createSettingsStore();

export function getSettingsStore(settingService: ISettingService | undefined): SettingsStore {
  if (
    !settingService ||
    (typeof settingService !== "object" && typeof settingService !== "function")
  ) {
    return unavailableSettingsStore;
  }
  const existing = stores.get(settingService);
  if (existing) {
    return existing;
  }
  const created = createSettingsStore();
  stores.set(settingService, created);
  return created;
}

function emitSettingsSnapshot(store: SettingsStore) {
  for (const listener of store.listeners) {
    listener(store.snapshot);
  }
}

function startSettingsRead(store: SettingsStore, settingService: ISettingService): Promise<void> {
  const generation = store.generation;
  store.snapshot = { ...store.snapshot, loading: true, error: null };
  emitSettingsSnapshot(store);

  const entry: InflightRead = {
    generation,
    promise: (async () => {
      try {
        const result = await settingService.get();
        // 发起之后又有要求更晚读取的刷新：这次读取可能早于那次写入，结果作废，由补读负责提交。
        if (generation !== store.generation) return;
        store.snapshot = { settings: result, loading: false, error: null };
        emitSettingsSnapshot(store);
      } catch (error) {
        if (generation !== store.generation) return;
        store.snapshot = {
          // 设置读取失败时保留旧快照，避免一次刷新错误把已可用的设置页降级为空状态。
          settings: store.snapshot.settings,
          loading: false,
          error,
        };
        emitSettingsSnapshot(store);
      }
    })().finally(() => {
      if (store.inflight === entry) store.inflight = null;
    }),
  };
  store.inflight = entry;
  return entry.promise;
}

/**
 * 读取设置到共享快照。
 *
 * 修复原因：`update` 之后的刷新与设置变更通知触发的刷新都曾直接复用在途读取；若那次读取发起于
 * 写入之前，结果会把保存前的值写回快照，界面短暂或持续停在旧值（复审 DEF-23）。
 * 依据：写后刷新的读取必须发起在写入之后。`fresh` 让更早发起的在途读取先结束并作废其结果，
 * 再补一次新读取；并发的 fresh 请求合并为这一次补读。普通刷新（挂载）仍共用在途读取。
 */
export async function refreshSettingsStore(
  settingService: ISettingService | undefined,
  options: { fresh?: boolean } = {},
): Promise<void> {
  const store = getSettingsStore(settingService);
  if (!settingService) {
    return;
  }
  if (options.fresh) store.generation += 1;
  for (;;) {
    const inflight = store.inflight;
    if (!inflight) break;
    if (inflight.generation === store.generation) return inflight.promise;
    await inflight.promise;
  }
  return startSettingsRead(store, settingService);
}
