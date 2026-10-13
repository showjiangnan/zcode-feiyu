// Modified by ZCode Feiyu.
import {
  setControlVisibility,
  controlSnapshot,
  markFrameUnavailable,
  visibleControlSources,
} from "./control-presentation.js";
import { stopControl, resumeControl, endControl } from "./control-lifecycle.js";
import {
  requestApproval,
  respondToApproval,
  findGrant,
  validateContextGrants,
} from "./application-access.js";
import {
  CuaError,
  contextKey,
  validateCall,
  validateContext,
  READ_ONLY,
} from "../domain/protocol.js";

import { updateControlSource, acceptControlFrame, checkControlSource } from "./control-source.js";
import { withControlAdmission } from "./control-admission.js";
import { projectApplicationGuidance } from "./application-guidance.js";
import { assertRetirementAvailable } from "./turn-retirement.js";
import { handleOperationFailure } from "./operation-failure.js";
import { interruptionState } from "../domain/control-interruption.js";

export class CuaCoordinator {
  constructor(ports) {
    this.ports = ports;
    this.native = ports.native;
    this.sources = new Map();
    this.approvals = new Map();
    this.grants = new Map();
    this.denied = new Set();
    this.stopped = new Map();
    this.stopping = new Map();
    this.paused = new Map();
    this.operations = new Map();
    this.admissions = new Map();
    this.visible = new Set();
    this.subscriptions = new Map();
    this.ended = new Set();
    this.retiredContexts = new Map();
    this.guidanceSeen = new Map();
    this.retirementSaturated = false;
    this.revision = 0;
    this.closed = false;
  }
  changed() {
    this.revision += 1;
    this.ports.changed?.(this.revision);
  }
  #grantKey(context, app) {
    return `${contextKey(context)}\0${app.appKey || app.appId}\0${app.fileIdentity || app.path}\0${app.processIncarnation || app.pid || "not-running"}`;
  }
  forgetSources(key, privacy = true) {
    for (const source of this.sources.values())
      if (contextKey(source.context) === key) {
        source.phase = "stopped";
        source.live = false;
        if (privacy) source.image = undefined;
        this.visible.delete(source.id);
      }
    this.changed();
  }
  async execute(method, value, contextValue, signal) {
    const context = validateContext(contextValue);
    return withControlAdmission(this, context, () =>
      this.executeAdmitted(method, value, context, signal),
    );
  }
  async executeAdmitted(method, value, context, signal) {
    const input = validateCall(method, value);
    const key = contextKey(context);
    if (this.closed) throw new CuaError("disposed", "Computer control service has closed");
    if (signal?.aborted) throw signal.reason;
    if (method === "close_session") {
      await this.native.call("release", { context });
      this.forgetSources(key);
      for (const [id, source] of this.sources)
        if (contextKey(source.context) === key) this.sources.delete(id);
      this.changed();
      return this.result({ status: "closed" });
    }
    if (method === "close_target") {
      const ids = [...this.sources.values()]
        .filter(
          (source) =>
            contextKey(source.context) === key &&
            (input.targetId
              ? source.targetId === input.targetId
              : input.windowId
                ? source.windowId === input.windowId
                : source.app.appId === input.appId),
        )
        .map((source) => source.id);
      for (const id of ids) {
        const source = this.sources.get(id);
        try {
          await this.native.call("close_target", { input: source.input, context });
        } catch (error) {
          if (
            !["target_unavailable", "stale_target", "disposed", "native_exited"].includes(
              error.code,
            )
          )
            throw error;
        }
        this.sources.delete(id);
        this.visible.delete(id);
      }
      this.changed();
      return this.result({ status: "closed" });
    }
    assertRetirementAvailable(this);
    if (this.ports.isTurnActive && !(await this.ports.isTurnActive(context)))
      throw new CuaError("turn_ended", "The task runtime no longer owns this turn");
    if (!(await this.ports.enabled(context))) {
      this.forgetSources(key);
      throw new CuaError("disabled", "Computer control is disabled for this workspace");
    }
    if (
      this.ended.has(`${context.workspaceKey}\0${context.sessionId}\0${context.turnId}`) ||
      this.ended.has(`${context.workspaceKey}\0${context.sessionId}\0*`)
    )
      throw new CuaError(
        "turn_ended",
        "This task turn has ended; start a new task turn to use computer control",
      );
    if (this.stopped.has(key))
      throw new CuaError(
        "turn_stopped",
        `Computer control stopped (${this.stopped.get(key).reason}); use the trusted Continue control action`,
        { reason: this.stopped.get(key).reason, origin: this.stopped.get(key).origin },
      );
    if (method === "stop_computer_control") {
      await this.stop(context, false, "model-stop");
      return this.result({ status: "stopped" });
    }
    if (this.paused.has(key) && !READ_ONLY.has(method) && method !== "request_access")
      throw new CuaError(
        "foreground_required",
        "Continue control through the local UI before changing the application",
        { reason: this.paused.get(key).reason, origin: this.paused.get(key).origin },
      );
    if (method === "capabilities" || method === "list_apps")
      return this.result(await this.native.call(method, {}, { signal }));
    let app = await this.native.call("resolve_application", { input }, { signal });
    const grantKey = this.#grantKey(context, app);
    if (method === "request_access")
      return await this.#requestApproval(context, app, grantKey, signal);
    const grant = await findGrant(this, context, app, grantKey, signal);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const operationId = this.ports.id();
    this.operations.set(operationId, { key, context, controller });
    let operationSubmitted = false;
    try {
      if (method === "get_state" || (!READ_ONLY.has(method) && method !== "launch_app")) {
        const target = await this.native.call(
          "resolve_target",
          {
            input,
            context,
            approved: true,
            application: app,
            authorizationGate: grant.authorization,
          },
          { signal: combined },
        );
        this.#source(context, app, { ...target, channels: {} }, input);
      }
      operationSubmitted = true;
      const result = await this.native.call(
        method,
        {
          input,
          context,
          approved: true,
          application: app,
          authorizationGate: grant.authorization,
          grantRevision: grant.revision,
        },
        { signal: combined },
      );
      if (
        this.stopped.has(key) ||
        !(await this.ports.enabled(context)) ||
        (this.ports.isTurnActive && !(await this.ports.isTurnActive(context))) ||
        (grant.authorization &&
          (await this.ports.grantGate?.(context))?.epoch !== grant.authorization.epoch)
      ) {
        this.forgetSources(key);
        throw new CuaError("revoked", "Control qualification changed during the operation", {
          outcome: READ_ONLY.has(method) ? "rejected" : "partial-or-unknown",
        });
      }
      if (method === "launch_app" && result.pid) {
        const launched = await this.native.call(
          "resolve_application",
          { input: { appId: result.appId || app.appId, pid: result.pid } },
          { signal: combined },
        );
        if (
          launched.appKey !== app.appKey ||
          launched.path !== app.path ||
          launched.fileIdentity !== app.fileIdentity
        )
          throw new CuaError(
            "application_changed",
            "Launched application does not match the approved executable",
          );
        this.grants.delete(grantKey);
        this.grants.set(this.#grantKey(context, launched), { ...grant, app: launched });
        app = launched;
      }
      const state = result.state || (method === "get_state" ? result : undefined);
      if (method === "launch_app" && Array.isArray(result.windows))
        for (const window of result.windows.slice(0, LIMITS.sources))
          this.#source(
            context,
            app,
            { ...window, channels: {} },
            { appId: result.appId || app.appId, pid: result.pid, windowId: window.windowId },
          );
      if (!["get_state", "list_windows"].includes(method))
        for (const source of this.sources.values())
          if (contextKey(source.context) === key) source.reason = undefined;
      if (state?.targetId) this.#source(context, app, state, input);
      projectApplicationGuidance(this, key, app, state);
      return this.result(result, app);
    } catch (error) {
      await handleOperationFailure(this, context, method, operationSubmitted, error);
      throw error;
    } finally {
      this.operations.delete(operationId);
    }
  }
  #requestApproval(context, app, grantKey, signal) {
    return requestApproval(this, context, app, grantKey, signal);
  }
  respond(id, allowed, scope = "turn") {
    return respondToApproval(this, id, allowed, scope);
  }
  async authorizationFor(context, app) {
    const grant = await findGrant(this, context, app, this.#grantKey(context, app));
    if (!grant) throw new CuaError("application_not_approved", "Application approval is required");
    return grant.authorization;
  }
  validateGrants(context) {
    return validateContextGrants(this, context);
  }
  #source(context, app, state, input) {
    updateControlSource(this, context, app, state, input);
  }
  acceptFrame(id, state, generation, source) {
    acceptControlFrame(this, id, state, generation, source);
  }
  checkSource(source) {
    return checkControlSource(this, source);
  }
  async previewFailed(source, error) {
    const current = () =>
      this.sources.get(source.id) === source && source.nativeGeneration === this.native.generation;
    if (!current()) return;
    // 窗口可能在周期探测之后关闭；先核对消失事实，不能把它误判成整个 turn 的授权撤销。
    if (
      ["application_changed", "target_unavailable", "stale_target", "capture_unavailable"].includes(
        error.code,
      )
    ) {
      try {
        await this.checkSource(source);
      } catch (probeError) {
        error = probeError;
      }
      if (!current()) return;
    }
    if (
      [
        "locked",
        "capture_revoked",
        "turn_stopped",
        "permission_revoked",
        "application_changed",
        "authorization_unavailable",
      ].includes(error.code)
    )
      await this.stop(source.context, true);
    else this.frameUnavailable(source.id, error.code || "capture_failed");
  }
  pause(context, reason = "foreground-changed", origin) {
    const key = contextKey(validateContext(context));
    if (this.paused.has(key) || this.stopped.has(key)) return;
    const state = interruptionState(
      this.revision + 1,
      reason,
      this.ports.now(),
      "unknown-stop",
      origin,
    );
    this.paused.set(key, state);
    this.ports.interrupted?.({ kind: "paused", context, ...state });
    for (const source of this.sources.values())
      if (contextKey(source.context) === key) {
        source.phase = "paused";
        source.live = false;
      }
    this.changed();
  }
  stop(context, privacy = false, reason, origin) {
    return stopControl(this, context, privacy, reason, origin);
  }
  resume(context, revision) {
    return resumeControl(this, context, revision);
  }
  end(event) {
    return endControl(this, event);
  }
  invalidate() {
    for (const operation of this.operations.values())
      operation.controller.abort(
        new CuaError("generation_changed", "Native runtime was restarted"),
      );
    for (const approval of this.approvals.values()) {
      approval.cleanup();
      approval.reject(new CuaError("generation_changed", "Native runtime was restarted"));
    }
    this.approvals.clear();
    this.grants.clear();
    for (const source of this.sources.values()) {
      source.image = undefined;
      source.live = false;
      source.nativeGeneration = "expired";
      // 重启仅使旧帧/资格失效；活跃 turn 的停止事实仍需显示可信继续，不能丢成无入口状态。
      const key = contextKey(source.context);
      source.phase = this.stopped.has(key)
        ? "stopped"
        : this.paused.has(key)
          ? "paused"
          : "unavailable";
    }
    this.changed();
  }
  setVisibility(ids, subscriber) {
    return setControlVisibility(this, ids, subscriber);
  }
  snapshot(workspaceKey, known) {
    return controlSnapshot(this, workspaceKey, known);
  }
  frameUnavailable(id, reason) {
    return markFrameUnavailable(this, id, reason);
  }
  previewSources() {
    return visibleControlSources(this);
  }
  result(body, app) {
    return this.ports.result
      ? this.ports.result(body, app)
      : { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
  }
  async dispose() {
    this.closed = true;
    this.guidanceSeen.clear();
    this.retiredContexts.clear();
    this.ended.clear();
    for (const request of this.operations.values())
      request.controller.abort(new CuaError("disposed", "Computer control closed"));
    for (const approval of this.approvals.values()) {
      approval.cleanup();
      approval.reject(new CuaError("disposed", "Computer control closed"));
    }
    this.approvals.clear();
    this.grants.clear();
    this.sources.clear();
    this.visible.clear();
    await this.native.close?.();
  }
}
