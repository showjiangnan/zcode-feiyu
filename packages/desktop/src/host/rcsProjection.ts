import type { RcsGrant } from "@zcode/shared";
type Json = Record<string, unknown>;
function object(value: unknown): Json | undefined {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
    ? (value as Json)
    : undefined;
}
function scopeKey(value: RcsGrant): string {
  return value.workspaceIdentity?.trim() || value.workspacePath;
}
const secretFields =
  /^(apiKey|password|secret|accessToken|refreshToken|authorization|x-api-key|token)$/i;
export function redactConfiguration(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfiguration);
  const input = object(value);
  if (!input) return value;
  return Object.fromEntries(
    Object.entries(input).map(([key, entry]) => [
      key,
      key.toLowerCase() === "headers" && object(entry)
        ? Object.fromEntries(Object.keys(entry as Json).map((name) => [name, ""]))
        : secretFields.test(key)
          ? ""
          : redactConfiguration(entry),
    ]),
  );
}
export function preserveSecrets(input: unknown, current: unknown): unknown {
  const value = object(input),
    existing = object(current);
  if (!value || !existing) return input;
  const result: Json = { ...value };
  for (const [key, entry] of Object.entries(existing)) {
    if (key.toLowerCase() === "headers" && object(entry)) {
      const headers = { ...object(result[key]) };
      for (const [name, value] of Object.entries(entry as Json))
        if (headers[name] === undefined || headers[name] === "") headers[name] = value;
      result[key] = headers;
    } else if (secretFields.test(key) && (result[key] === undefined || result[key] === ""))
      result[key] = entry;
    else if (object(entry)) result[key] = preserveSecrets(result[key] ?? {}, entry);
  }
  return result;
}

export function filterRcsControllerFrame(value: unknown, grant: RcsGrant): unknown {
  function visibleScope(value: unknown): boolean {
    const input = object(value);
    return (
      input?.workspacePath === grant.workspacePath &&
      (typeof input.workspaceIdentity === "string"
        ? input.workspaceIdentity
        : input.workspacePath) === scopeKey(grant) &&
      input.remoteSessionId === grant.remoteSessionId
    );
  }
  function filterController(value: unknown): unknown {
    const frame = object(value),
      payload = object(frame?.payload);
    if (!frame || !payload) return value;
    const snapshot = object(payload.snapshot);
    if (snapshot)
      return {
        ...frame,
        payload: {
          ...payload,
          snapshot: {
            ...snapshot,
            ...(Array.isArray(snapshot.workspaces)
              ? { workspaces: snapshot.workspaces.filter(visibleScope) }
              : {}),
            ...(Array.isArray(snapshot.tasks)
              ? { tasks: snapshot.tasks.filter((item) => visibleScope(object(item)?.address)) }
              : {}),
          },
        },
      };
    if (Array.isArray(payload.deltas))
      return {
        ...frame,
        payload: {
          ...payload,
          deltas: payload.deltas.filter((item) => {
            const delta = object(item);
            return visibleScope(
              object(delta?.task)?.address ?? delta?.address ?? delta?.workspace ?? delta,
            );
          }),
        },
      };
    return value;
  }

  return filterController(value);
}
