// Modified by ZCode Feiyu contributors (2026).
import type { OrchestrationMode, OrchestrationState } from "@zcode/shared/zcode-protocol-v4";

export function requestOrchestrationMode(
  current: OrchestrationState,
  mode: OrchestrationMode,
  busy: boolean,
): OrchestrationState {
  if (current.requested === mode && (busy || current.effective === mode)) return current;
  return {
    ...current,
    requested: mode,
    effective: busy ? current.effective : mode,
    revision: current.revision + 1,
  };
}

export function activateRequestedOrchestrationMode(
  current: OrchestrationState,
): OrchestrationState {
  if (current.requested === current.effective) return current;
  return {
    ...current,
    effective: current.requested,
    revision: current.revision + 1,
  };
}
