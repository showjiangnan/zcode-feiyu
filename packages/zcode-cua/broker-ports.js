// Modified by ZCode Feiyu contributors (2026).
export function isCuaPermissionStatusAvailable(result) {
  return (
    Boolean(result) &&
    typeof result === "object" &&
    result.available !== false &&
    typeof result.accessibility === "string" &&
    typeof result.screenRecording === "string"
  );
}

export function shouldRunCuaScreenCaptureProbe(state, options) {
  return state === "granted" && options?.probeScreenCapture === true;
}
