// Modified by ZCode Feiyu contributors (2026).
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { NativeProcess } from "./native-process.js";
import { serve } from "./ipc-server.js";
import { CuaCoordinator } from "../app/coordinator.js";
import { modelResult } from "./result.js";
import { persistentGrants, pluginEnabled } from "./configuration.js";
import { helperIdentity } from "./helper-installer.js";
import { CuaError } from "../domain/protocol.js";
import { createPreviewSampler } from "./preview-sampler.js";
import { validateControlPresentation } from "../../control-contract.js";

export function createHelperHost(options = {}) {
  const token = randomBytes(32).toString("hex");
  const authority = randomBytes(24).toString("hex");
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\zcode-cua-${randomUUID()}`
      : join(tmpdir(), `zcc-${randomUUID()}.sock`);
  let server;
  let native;
  let coordinator;
  let startup;
  let restartPending;
  let grants;
  let disposed = false;
  let visibleSourcesKey = "";
  let presentation;
  const createNative = (executable, args = []) => {
    const instance = new NativeProcess(executable, args, {
      onEvent: (event) => {
        if (native !== instance) return;
        if (
          ["runtime-exited", "runtime-unresponsive", "runtime-close-unconfirmed"].includes(
            event.kind,
          )
        )
          coordinator?.invalidate();
        else if (event.kind === "control-paused")
          coordinator?.pause(event.context, event.reason, event.origin);
        else if (event.kind === "control-stopped" && coordinator)
          void coordinator
            .stop(event.context, event.reason === "locked", event.reason, event.origin)
            .catch((error) => {
              options.logger?.warn?.("Native computer control stop could not be confirmed", {
                code: error.code || "stop_unknown",
              });
            });
      },
    });
    if (presentation) instance.setPresentation(presentation);
    return instance;
  };
  const enabled =
    options.isEnabled ||
    ((context) => pluginEnabled({ env: options.env, workingDirectory: context.workspacePath }));
  const sample = async () => {
    if (disposed || !coordinator) return;
    try {
      const contexts = new Map(
        [
          ...coordinator.sources.values(),
          ...coordinator.approvals.values(),
          ...coordinator.operations.values(),
          ...coordinator.grants.values(),
        ].map((value) => [JSON.stringify(value.context), value.context]),
      );
      for (const context of contexts.values()) {
        try {
          await coordinator.validateGrants(context);
          if (options.isTurnActive && !(await options.isTurnActive(context)))
            await coordinator.end({ kind: "turn-ended", ...context });
          else if (
            !(await enabled(context)) &&
            !coordinator.stopped.has((await import("../domain/protocol.js")).contextKey(context))
          )
            await coordinator.stop(context, true);
        } catch (error) {
          // owner 不可查询时停止并清除隐私帧；查询异常不能留下仍然“实时”的旧画面。
          await coordinator.stop(context, true);
          options.logger?.warn?.("Computer control preview qualification failed", {
            code: error.code || "control_failed",
          });
        }
      }
      await Promise.all(
        coordinator.previewSources().map(async (source) => {
          if (!(await enabled(source.context))) {
            await coordinator.stop(source.context, true);
            return;
          }
          const generation = native.generation;
          try {
            const frame = await native.call(
              "preview",
              {
                input: source.input,
                context: source.context,
                approved: true,
                application: source.app,
                authorizationGate: await coordinator.authorizationFor(source.context, source.app),
              },
              { timeoutMs: 5000 },
            );
            coordinator.acceptFrame(source.id, frame, generation);
          } catch (error) {
            if (
              error.code === "locked" ||
              error.code === "capture_revoked" ||
              error.code === "turn_stopped" ||
              error.code === "permission_revoked" ||
              error.code === "application_changed" ||
              error.code === "authorization_unavailable"
            )
              await coordinator.stop(source.context, true);
            else coordinator.frameUnavailable(source.id, error.code || "capture_failed");
          }
        }),
      );
    } catch (error) {
      options.logger?.warn?.("Computer control preview qualification failed", {
        code: error.code || "control_failed",
      });
    }
  };
  const sampler = createPreviewSampler({
    sample,
    hasActivity: () =>
      Boolean(
        coordinator?.sources.size || coordinator?.approvals.size || coordinator?.operations.size,
      ),
  });
  const projectionChanged = () => {
    const key =
      coordinator
        ?.previewSources()
        .map((source) => source.id)
        .sort()
        .join("\0") || "";
    if (key === visibleSourcesKey) return;
    visibleSourcesKey = key;
    if (key) sampler.wake();
  };
  async function start() {
    if (disposed) throw new CuaError("disposed", "Control lifecycle is disposed");
    if (server) return handle();
    if (startup) return startup;
    startup = (async () => {
      let executable;
      let args = [];
      if (options.nativeExecutable) executable = options.nativeExecutable;
      else {
        const appPath = await options.helperInstaller.ensureInstalled();
        executable = (await helperIdentity(appPath)).executablePath;
      }
      native = createNative(executable, args);
      grants = persistentGrants(join(options.env?.HOME || homedir(), ".zcode", "cua"));
      coordinator = new CuaCoordinator({
        native,
        enabled,
        isTurnActive: options.isTurnActive,
        id: randomUUID,
        now: Date.now,
        interrupted: ({ kind, reason, origin, context, revision }) =>
          options.logger?.info?.("Computer control interrupted", {
            kind,
            reason,
            origin,
            sessionId: context.sessionId,
            turnId: context.turnId,
            revision,
          }),
        changed: projectionChanged,
        grantGate: grants.gate,
        result: (body, app) => modelResult(body, app, token),
      });
      server = await serve({
        socketPath,
        token,
        diagnostics: new Set(["ping", "permission_status", "screen_recording_preflight"]),
        execute: async (method, params, signal) => {
          if (method === "ping")
            return {
              bundleId: "dev.zcode.cua-helper",
              pid: native.child?.pid || process.pid,
              protocolVersion: "zcode-cua/1",
            };
          if (method === "permission_status") return native.preflight();
          if (method === "screen_recording_preflight")
            return (await native.preflight()).screen_recording;
          if (method === "execute")
            return coordinator.execute(params.method, params.input, params.context, signal);
          if (method === "pip_event") {
            if (
              ["turn-ended", "turn-completed", "turn-failed", "session-closed"].includes(
                params.kind,
              )
            )
              await coordinator.end(params);
            return { applied: true };
          }
          throw new CuaError("unknown_method", "Unsupported broker method");
        },
      });
      sampler.wake();
      return handle();
    })();
    try {
      return await startup;
    } finally {
      startup = undefined;
    }
  }
  function handle() {
    return {
      socketPath,
      pluginAuthority: authority,
      brokerToken: token,
      helperAppPath: options.bundledHelperAppPath,
      bundleId: "dev.zcode.cua-helper",
      pid: native?.child?.pid || null,
    };
  }
  async function stop() {
    disposed = true;
    sampler.stop();
    await startup?.catch(() => undefined);
    await restartPending?.catch(() => undefined);
    await server?.close();
    server = undefined;
    await coordinator?.dispose();
    coordinator = undefined;
  }
  return {
    get running() {
      return Boolean(server) && !disposed;
    },
    get socketPath() {
      return server ? socketPath : null;
    },
    get pluginAuthority() {
      return server ? authority : null;
    },
    get reservedTransport() {
      return server ? handle() : undefined;
    },
    start,
    stop,
    async restart() {
      const result = await this.restartAfterCurrentStartPreservingTransport();
      return result.handle;
    },
    async restartAfterCurrentStart() {
      await startup;
      return this.restart();
    },
    restartAfterCurrentStartPreservingTransport() {
      if (restartPending) return restartPending;
      // 多个设置页/Host participant 合并同一次重启，旧实例退出之前不建立第二条原生链路。
      restartPending = (async () => {
        await startup;
        if (disposed) throw new CuaError("disposed", "Control lifecycle is disposed");
        if (!native) return { handle: await start(), reused: false };
        const old = coordinator;
        old.invalidate();
        await native.close();
        if (disposed) throw new CuaError("disposed", "Control lifecycle is disposed");
        const executable =
          options.nativeExecutable ||
          (await helperIdentity(await options.helperInstaller.ensureInstalled())).executablePath;
        if (disposed) throw new CuaError("disposed", "Control lifecycle is disposed");
        native = createNative(executable);
        old.native = native;
        old.grants.clear();
        return { handle: handle(), reused: true };
      })().finally(() => {
        restartPending = undefined;
      });
      return restartPending;
    },
    async waitForTransport() {
      return start();
    },
    async checkHealth() {
      await start();
      if (native.disposed)
        throw new CuaError("native_unavailable", "Native control requires explicit restart");
      return {
        bundleId: native.child?.pid ? "dev.zcode.cua-helper" : null,
        pid: native.child?.pid || null,
      };
    },
    async queryPermissionStatus() {
      await start();
      return native.preflight();
    },
    async queryScreenRecordingPreflight() {
      return (await this.queryPermissionStatus()).screen_recording;
    },
    async queryScreenCaptureProbe() {
      const source = coordinator?.previewSources()[0];
      if (!source) return { ok: false, reason: "Capture will be verified on an approved target" };
      const frame = await native.call("preview", {
        input: source.input,
        context: source.context,
        approved: true,
        application: source.app,
        authorizationGate: await coordinator.authorizationFor(source.context, source.app),
      });
      return { ok: Boolean(frame.image) };
    },
    getControlSnapshot(workspaceKey) {
      return (
        coordinator?.snapshot(workspaceKey) || {
          schemaVersion: 1,
          revision: 0,
          sources: [],
          approvals: [],
        }
      );
    },
    setControlPresentation(value) {
      presentation = validateControlPresentation(value);
      native?.setPresentation(presentation);
    },
    async respondToControlApproval(id, allowed, scope) {
      if (!coordinator) throw new CuaError("unavailable", "Control service is not running");
      await coordinator.respond(id, allowed, scope);
    },
    async stopControl(context) {
      if (coordinator) await coordinator.stop(context);
    },
    async resumeControl(context, revision) {
      if (coordinator) await coordinator.resume(context, revision);
    },
    setControlVisibility(ids, subscriber) {
      coordinator?.setVisibility(ids, subscriber);
    },
    async revokeControlGrants(workspaceKey) {
      if (!grants) grants = persistentGrants(join(options.env?.HOME || homedir(), ".zcode", "cua"));
      await grants.revoke(workspaceKey);
      if (!coordinator) return;
      const contexts = new Map(
        [
          ...coordinator.sources.values(),
          ...coordinator.approvals.values(),
          ...coordinator.grants.values(),
          ...coordinator.operations.values(),
        ]
          .filter((value) => value.context.workspaceKey === workspaceKey)
          .map((value) => [JSON.stringify(value.context), value.context]),
      );
      for (const context of contexts.values()) await coordinator.stop(context, true);
      for (const [id, grant] of coordinator.grants)
        if (grant.context.workspaceKey === workspaceKey) coordinator.grants.delete(id);
    },
  };
}
