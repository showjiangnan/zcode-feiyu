// Modified by ZCode Feiyu contributors (2026).
export function isControlSnapshot(value) {
  return Boolean(
    value &&
    value.schemaVersion === 1 &&
    Number.isSafeInteger(value.revision) &&
    Array.isArray(value.sources) &&
    Array.isArray(value.approvals),
  );
}

export function validateControlPresentation(value) {
  const fields = ["captionSize", "foreground", "background", "border", "accent", "labels"];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    !Number.isFinite(value.captionSize) ||
    value.captionSize < 8 ||
    value.captionSize > 32
  )
    throw new Error("Invalid native control presentation");
  for (const key of fields.slice(1, 5))
    if (
      !Array.isArray(value[key]) ||
      value[key].length !== 4 ||
      [...value[key]].some((number) => !Number.isFinite(number) || number < 0 || number > 1)
    )
      throw new Error("Invalid native control presentation color");
  const phases = ["observing", "active", "waiting", "paused"];
  if (
    !value.labels ||
    typeof value.labels !== "object" ||
    Array.isArray(value.labels) ||
    Object.keys(value.labels).length !== phases.length ||
    phases.some(
      (key) =>
        typeof value.labels[key] !== "string" ||
        !value.labels[key].trim() ||
        value.labels[key].length > 80,
    )
  )
    throw new Error("Invalid native control presentation labels");
  return structuredClone(value);
}
