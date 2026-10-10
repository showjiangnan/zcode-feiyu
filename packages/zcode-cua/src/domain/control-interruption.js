// Modified by ZCode Feiyu contributors (2026).
// 原生输入来源只能携带有界语义，不能把键值、窗口正文或任意错误串写入生产诊断。
const reasons = new Set([
  "target-escape",
  "target-closed",
  "target-keyboard",
  "target-pointer",
  "foreground-changed",
  "locked",
  "input-cleanup-unconfirmed",
  "trusted-ui-stop",
  "model-stop",
  "qualification-lost",
  "turn-ended",
  "device_quarantined",
  "unknown-stop",
]);
const origins = new Set([
  "native",
  "external-input",
  "system-or-unclassified",
  "trusted-ui",
  "model",
  "runtime",
]);
export function interruptionState(revision, reason, at, fallback = "unknown-stop", origin) {
  const boundedReason = reasons.has(reason) ? reason : fallback;
  const defaultOrigin =
    boundedReason === "trusted-ui-stop"
      ? "trusted-ui"
      : boundedReason === "model-stop"
        ? "model"
        : ["qualification-lost", "turn-ended"].includes(boundedReason)
          ? "runtime"
          : "native";
  return {
    revision,
    reason: boundedReason,
    origin: origins.has(origin) ? origin : defaultOrigin,
    at,
  };
}
