// Modified by ZCode Feiyu contributors (2026).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CuaHelperError } from "./broker.js";
import { createHelperHost } from "./src/adapters/helper-host.js";
import {
  createInstaller,
  helperIdentity,
  verifierDependencies,
} from "./src/adapters/helper-installer.js";
import { pluginEnabled } from "./src/adapters/configuration.js";

export const HELPER_ADDON_ENV = "ZCODE_CUA_HELPER_ADDON";
export const WINDOWS_DEV_CONTROL_PROTOCOL = "zcode-cua-windows-dev/v1";

const UNAVAILABLE = "Computer Use is not available in this build.";

function unavailableReject() {
  return Promise.reject(new CuaHelperError(UNAVAILABLE));
}

export function buildHelperOpenArgs(_spec, _launcherPid) {
  return [];
}

export async function resolveHelperPermissionSubjectIdentity(appPath) {
  return helperIdentity(appPath);
}

export function isCuaLocalDevelopmentRuntime(_env, _compiledLocalDevelopmentRuntime) {
  return false;
}

export function createCuaHelperInstaller(options) {
  return createInstaller(options);
}

export const defaultCuaHelperVerifierDependencies = verifierDependencies;

export function cuaBrokerRefreshMarkerPath(_socketPath) {
  return undefined;
}

export async function publishCuaBrokerRefreshMarker(_socketPath, _options) {
  return { path: undefined };
}

export function loadRealNativeAddon(_options) {
  throw new CuaHelperError(UNAVAILABLE);
}

export function resolvePackagedNativeAddonPath(_options) {
  return undefined;
}

export function resolveInTreeAddonPath(_options) {
  return undefined;
}

export function createAxReadOnlyMethods(_source, _registry, _options) {
  return {};
}

export const ROLE_TO_KIND = {};

export function roleToKind(_role) {
  return undefined;
}

export class CuaHelperLifecycleManager {
  #dispose;
  #current;
  #disposed = false;
  #tail = Promise.resolve();
  constructor(dispose) {
    this.#dispose = dispose;
    this.#current = undefined;
  }
  acquire(options) {
    const work = this.#tail.then(() => this.acquireCurrent(options));
    this.#tail = work.catch(() => undefined);
    return work;
  }
  async acquireCurrent(options) {
    if (this.#disposed) return undefined;
    if (typeof options?.isAdmitted === "function" && !options.isAdmitted()) {
      return undefined;
    }
    if (this.#current && (options.shouldRetainCurrent?.(this.#current) ?? true))
      return this.#current;
    const managed = await options?.create?.();
    if (this.#disposed) {
      await this.#dispose?.(managed);
      return undefined;
    }
    if (this.#current && this.#current !== managed) await this.#dispose?.(this.#current);
    this.#current = managed;
    return managed;
  }
  peek() {
    return this.#current;
  }
  get disposed() {
    return this.#disposed;
  }
  async dispose(managed) {
    this.#disposed = true;
    await this.#dispose?.(managed ?? this.#current);
    this.#current = undefined;
  }
}

export class CuaProductHelperWorkspaceRegistry {
  enabled = new Map();
  setEnabled(context, enabled) {
    const key = context?.workspaceIdentity?.trim() || context?.workspacePath;
    if (key) {
      if (enabled) this.enabled.set(key, true);
      else this.enabled.delete(key);
    }
  }
}

export function createProductCuaHelperHost(options) {
  return createHelperHost(options);
}

export function isOfficialCuaPluginEnabledForWorkspace(options) {
  return pluginEnabled(options);
}

export function createCuaProductMcpServerResolver(host, _options) {
  return {
    async resolveMcpServers(servers, context) {
      const handle = await host.start();
      return servers?.map((server) =>
        isPotentialZCodeCuaAgentMcpServer(server)
          ? {
              ...server,
              env: {
                ...server.env,
                ZCODE_CUA_PERMISSION_BROKER_SOCKET: handle.socketPath,
                ZCODE_CUA_BROKER_TOKEN: handle.brokerToken,
                ZCODE_CUA_PLUGIN_AUTHORITY: handle.pluginAuthority,
              },
            }
          : server,
      );
    },
    async restart() {
      await host.restart();
    },
    async restartAfterPermissionGrant(_onboardingSessionId) {
      await host.restartAfterCurrentStartPreservingTransport?.();
    },
  };
}

export async function waitForCuaHelperStartup(startup, _deadlineMs) {
  return await startup;
}

export function isPotentialZCodeCuaAgentMcpServer(server) {
  return server?.name === "node_repl" || server?.name === "computer-use";
}

export function isScreenCaptureProbeSuccess(probe) {
  return probe?.ok === true;
}

const unavailableHosts = new WeakSet();
export function markCuaProductHelperAgentEnvUnavailable(host) {
  unavailableHosts.add(host);
}

export function hasCuaProductHelperAgentEnvUnavailable(host) {
  return unavailableHosts.has(host);
}

export function clearCuaProductHelperAgentEnvUnavailable(host) {
  unavailableHosts.delete(host);
}

export async function reapOrphanedHelpers(_options) {}

async function requestPermission(options, flag) {
  if (process.platform !== "darwin" || !options?.appPath)
    throw new CuaHelperError("A verified macOS helper is required");
  await promisify(execFile)("/usr/bin/open", ["-n", "-W", "-a", options.appPath, "--args", flag], {
    timeout: 120000,
  });
  return { ok: true };
}
export async function requestHelperAccessibilityPermissionViaLaunchServices(options) {
  return requestPermission(options, "--request-accessibility");
}

export async function requestHelperScreenRecordingPermissionViaLaunchServices(options) {
  return requestPermission(options, "--request-screen-recording");
}
