// Modified by ZCode Feiyu contributors (2026).
import { create } from "zustand";
import type { ControlSnapshot } from "@zcode/zcode-cua/control-contract";

interface ComputerControlPresentationStore {
  snapshots: Record<string, ControlSnapshot>;
  publish(key: string, snapshot: ControlSnapshot): void;
  release(key: string): void;
}
// 仅保存当前展示帧；原生/Host 持有控制事实，Renderer 不写入 task 或 grant 状态。
export const useComputerControlStore = create<ComputerControlPresentationStore>((set) => ({
  snapshots: {},
  publish: (key, snapshot) =>
    set((state) =>
      state.snapshots[key]?.generation === snapshot.generation &&
      (state.snapshots[key]?.revision ?? -1) >= snapshot.revision
        ? state
        : { snapshots: { ...state.snapshots, [key]: snapshot } },
    ),
  release: (key) =>
    set((state) => {
      const snapshots = { ...state.snapshots };
      delete snapshots[key];
      return { snapshots };
    }),
}));
