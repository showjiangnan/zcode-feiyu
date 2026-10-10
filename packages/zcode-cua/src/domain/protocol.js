// Modified by ZCode Feiyu contributors (2026).
export const PROTOCOL = "zcode-cua/1";
export const LIMITS = Object.freeze({
  requestBytes: 1_048_576,
  responseBytes: 33_554_432,
  connections: 64,
  inFlight: 32,
  operationMs: 30_000,
  mediaBytes: 67_108_864,
  sources: 32,
  visibleSources: 4,
});
export const METHODS = new Set([
  "capabilities",
  "list_apps",
  "list_windows",
  "launch_app",
  "request_access",
  "get_state",
  "activate",
  "click",
  "move",
  "drag",
  "scroll",
  "press_key",
  "type_text",
  "set_value",
  "secondary_action",
  "select_text",
  "stop_computer_control",
  "close_session",
  "close_target",
]);
export const READ_ONLY = new Set(["capabilities", "list_apps", "list_windows", "get_state"]);
const selectors = [
  "appId",
  "app",
  "identifier",
  "pid",
  "windowId",
  "targetId",
  "observationId",
  "imageId",
  "elementId",
];
const fields = {
  get_state: [
    "image",
    "text",
    "maxNodes",
    "childOffset",
    "diff",
    "disableDiff",
    "baselineRevision",
    "region",
    "autoLaunch",
  ],
  click: ["x", "y", "button", "clickCount", "verifyImage"],
  move: ["x", "y", "verifyImage"],
  drag: ["path", "button", "verifyImage"],
  scroll: ["x", "y", "dx", "dy", "unit", "verifyImage"],
  press_key: ["key", "physicalKeyCode", "scanCode", "extended", "verifyImage"],
  type_text: ["text", "mode", "verifyImage"],
  set_value: ["text", "value", "verifyImage"],
  secondary_action: ["action", "verifyImage"],
  select_text: ["text", "prefix", "suffix", "occurrence", "mode", "verifyImage"],
};

export class CuaError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "CuaError";
    this.code = code;
    this.details = details;
  }
}
export function object(value, name = "input") {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CuaError("invalid_request", `${name} must be an object`);
  return value;
}
export function text(value, name, maximum = 4096) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new CuaError("invalid_request", `${name} is invalid`);
  return value.trim();
}
export function contextKey(context) {
  return `${context.workspaceIdentity?.trim() || context.workspacePath || context.workspaceKey}\0${context.sessionId}\0${context.turnId}`;
}
export function validateContext(value) {
  const input = object(value, "context");
  if (input.remoteSessionId) {
    throw new CuaError(
      "remote_workspace_unavailable",
      "Computer Control requires a local workspace; remote workspace requests cannot operate this desktop",
    );
  }
  if (input.runtimeScope !== "main")
    throw new CuaError("subagent_denied", "Computer Use is not available in subagent");
  if (typeof input.taskType === "string" && input.taskType.endsWith("_child"))
    throw new CuaError("child_task_denied", "Computer Control requires a top-level main task");
  const sessionId = text(input.sessionId, "sessionId", 255);
  const turnId = text(input.turnId, "turnId", 255);
  const workspaceKey = input.workspaceIdentity?.trim() || input.workspacePath || input.workspaceKey;
  text(workspaceKey, "workspaceKey");
  return { ...input, runtimeScope: "main", sessionId, turnId, workspaceKey };
}
export function validateCall(method, value) {
  if (!METHODS.has(method))
    throw new CuaError("unknown_method", `Unsupported Computer Use method: ${method}`);
  const input = value === undefined ? {} : object(value);
  const allowed = new Set([...selectors, ...(fields[method] || [])]);
  if (fields[method] && method !== "get_state") allowed.add("inputMode");
  for (const key of Object.keys(input))
    if (!allowed.has(key)) throw new CuaError("invalid_request", `Unsupported input field: ${key}`);
  if (input.inputMode !== undefined && !["isolated", "foreground"].includes(input.inputMode))
    throw new CuaError("invalid_request", "inputMode must be isolated or foreground");
  for (const key of ["image", "diff", "disableDiff", "autoLaunch", "verifyImage", "extended"])
    if (input[key] !== undefined && typeof input[key] !== "boolean")
      throw new CuaError("invalid_request", `${key} must be boolean`);
  if (method === "get_state" && input.text !== undefined && typeof input.text !== "boolean")
    throw new CuaError("invalid_request", "text must be boolean for observations");
  for (const key of [
    "appId",
    "app",
    "identifier",
    "targetId",
    "observationId",
    "imageId",
    "elementId",
    "baselineRevision",
    "key",
    "action",
  ])
    if (input[key] !== undefined) text(input[key], key);
  for (const key of ["value", "prefix", "suffix"])
    if (
      input[key] !== undefined &&
      (typeof input[key] !== "string" || input[key].length > (key === "value" ? 100000 : 4096))
    )
      throw new CuaError("invalid_request", `Invalid ${key}`);
  if (Buffer.byteLength(JSON.stringify(input)) > LIMITS.requestBytes)
    throw new CuaError("input_too_large", "Computer Use input exceeds 1 MiB");
  for (const key of [
    "x",
    "y",
    "dx",
    "dy",
    "duration",
    "pid",
    "button",
    "clickCount",
    "physicalKeyCode",
    "scanCode",
  ]) {
    if (
      input[key] !== undefined &&
      (typeof input[key] !== "number" || !Number.isFinite(input[key]))
    )
      throw new CuaError("invalid_request", `${key} must be finite`);
  }
  if (
    input.pid !== undefined &&
    (!Number.isInteger(input.pid) || input.pid <= 0 || input.pid > 2_147_483_647)
  )
    throw new CuaError("invalid_request", "pid is outside its range");
  if (
    method !== "get_state" &&
    input.text !== undefined &&
    (typeof input.text !== "string" || input.text.length > 100_000)
  )
    throw new CuaError("invalid_request", "text exceeds its limit");
  for (const [key, maximum] of [
    ["physicalKeyCode", 127],
    ["scanCode", 511],
  ])
    if (
      input[key] !== undefined &&
      (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > maximum)
    )
      throw new CuaError("invalid_request", `${key} is outside its physical key range`);
  for (const [key, minimum, maximum] of [
    ["windowId", 1, Number.MAX_SAFE_INTEGER],
    ["maxNodes", 1, 5000],
    ["childOffset", 0, 100000],
    ["occurrence", 0, 100000],
    ["button", 0, 2],
  ])
    if (
      input[key] !== undefined &&
      (!Number.isInteger(input[key]) || input[key] < minimum || input[key] > maximum)
    )
      throw new CuaError("invalid_request", `Invalid ${key}`);
  if (
    method === "select_text" &&
    input.mode !== undefined &&
    !["select", "before", "after"].includes(input.mode)
  )
    throw new CuaError("invalid_request", "Invalid selection mode");
  if (input.unit !== undefined && !["pixels", "points", "lines", "pages"].includes(input.unit))
    throw new CuaError("invalid_request", "Unknown scroll unit");
  if (
    input.mode !== undefined &&
    method === "type_text" &&
    !["unicode", "clipboard"].includes(input.mode)
  )
    throw new CuaError("invalid_request", "Unknown text input mode");
  if (
    input.path !== undefined &&
    (!Array.isArray(input.path) ||
      input.path.length < 2 ||
      input.path.length > 1000 ||
      input.path.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y)))
  )
    throw new CuaError("invalid_request", "drag path is invalid");
  if (
    input.clickCount !== undefined &&
    (!Number.isInteger(input.clickCount) || input.clickCount < 1 || input.clickCount > 3)
  )
    throw new CuaError("invalid_request", "clickCount must be 1–3");
  if (input.region !== undefined) {
    const region = object(input.region, "region");
    for (const key of ["x", "y", "width", "height"])
      if (
        !Number.isFinite(region[key]) ||
        region[key] < (key === "width" || key === "height" ? 1 : 0)
      )
        throw new CuaError("invalid_request", "Capture region is invalid");
  }
  return input;
}
export function errorResult(error) {
  return {
    content: [{ type: "text", text: error.message }],
    isError: true,
    structuredContent: {
      error: {
        code: error.code || "native_error",
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    },
  };
}
