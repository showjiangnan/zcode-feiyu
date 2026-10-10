// Modified by ZCode Feiyu contributors (2026).
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "./src/adapters/ipc-client.js";
import { METHODS, READ_ONLY } from "./src/domain/protocol.js";

export const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
export const BROKER_UNAVAILABLE_ENV = "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";

export class BrokerError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use broker is unavailable.");
    this.name = "BrokerError";
    this.code = options.code ?? "unavailable";
    if (options.details !== undefined) this.details = options.details;
  }
}

export class CuaHelperError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use Helper is unavailable.");
    this.name = "CuaHelperError";
    this.code = options.code ?? "helper_unavailable";
  }
}

export function isCuaHelperError(value) {
  return value instanceof CuaHelperError;
}

const brokerErrorFactory = (code) => (message, details) =>
  new BrokerError(message ?? code, { code, details });

export const notAuthorized = brokerErrorFactory("not_authorized");
export const notSelectable = brokerErrorFactory("not_selectable");
export const notSettable = brokerErrorFactory("not_settable");
export const elementUnavailable = brokerErrorFactory("element_unavailable");
export const actionUnavailable = brokerErrorFactory("action_unavailable");
export const foregroundRequired = brokerErrorFactory("foreground_required");

export async function callBrokerMethod(args) {
  return request(args);
}

export async function probeHelperHealth(socketPath, options = {}) {
  return request({ socketPath, method: "ping", timeoutMs: options.timeoutMs || 3000 });
}

export function mintBrokerSocketPath(options = {}) {
  const dir = typeof options.dir === "string" ? options.dir : tmpdir();
  return join(dir, `zcode-cua-broker-${randomUUID()}.sock`);
}

export function resolveBrokerSocketPath(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env[BROKER_SOCKET_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv;
  return mintBrokerSocketPath(options);
}

export function parseRequestLine(line) {
  try {
    const input = JSON.parse(line);
    return input && typeof input.method === "string" && !Array.isArray(input) ? input : undefined;
  } catch {
    return undefined;
  }
}

export function okResponse(result) {
  return { ok: true, result };
}

export function errorResponse(message, options = {}) {
  return {
    ok: false,
    error: { message, ...(options.code ? { code: options.code } : {}) },
  };
}

export function errorResponseFromException(error) {
  return errorResponse(error instanceof Error ? error.message : String(error));
}

export function serializeResponse(response) {
  return `${JSON.stringify(response)}\n`;
}

export async function dispatchRequest(backend, input) {
  if (!isBrokerMethod(input.method) || typeof backend[input.method] !== "function")
    return errorResponse("Unknown Computer Use method", { code: "unknown_method" });
  try {
    return okResponse(await backend[input.method](input.params));
  } catch (error) {
    return errorResponseFromException(error);
  }
}

export async function handleRequestLine(backend, line) {
  const input = parseRequestLine(line);
  return input
    ? dispatchRequest(backend, input)
    : errorResponse("Invalid request", { code: "invalid_request" });
}

export function isBrokerMethod(method) {
  return METHODS.has(method);
}

export function isReadOnlyBrokerMethod(method) {
  return READ_ONLY.has(method);
}
