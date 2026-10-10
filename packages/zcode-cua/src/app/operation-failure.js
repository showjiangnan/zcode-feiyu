// Modified by ZCode Feiyu contributors (2026).
import { contextKey, READ_ONLY } from "../domain/protocol.js";
import { revokeQualification } from "./application-access.js";
import { interruptionState } from "../domain/control-interruption.js";

export async function handleOperationFailure(owner, context, method, operationSubmitted, error) {
  const key = contextKey(context);
  if (error.code === "turn_owner_unavailable") {
    // 动作提交后 owner 查询失败不能证明动作未执行；保留未知结果，禁止透明重放。
    error.details = {
      ...error.details,
      outcome: READ_ONLY.has(method) || !operationSubmitted ? "rejected" : "partial-or-unknown",
    };
  }
  if (
    [
      "permission_revoked",
      "authorization_unavailable",
      "application_changed",
      "revoked",
      "turn_owner_unavailable",
    ].includes(error.code)
  )
    await revokeQualification(owner, context);
  if (error.code === "foreground_required") owner.pause(context);
  if (error.code === "device_quarantined") {
    owner.pause(context, "device_quarantined");
    for (const source of owner.sources.values())
      if (contextKey(source.context) === key) source.reason = "device_quarantined";
    owner.changed();
  }
  if (error.code === "device_busy")
    for (const source of owner.sources.values())
      if (contextKey(source.context) === key) {
        source.phase = "busy";
        source.reason = "device_busy";
      }
  if (error.code === "stop_unconfirmed") {
    // 动作失败中的按键清理也需要原生确认；不能直接投影成“已停止”。
    await owner.stop(context, true).catch(() => undefined);
  } else if (error.code === "turn_stopped" || error.code === "locked") {
    if (!owner.stopped.has(key)) {
      const state = interruptionState(
        owner.revision + 1,
        error.code === "locked" ? "locked" : error.details?.reason,
        owner.ports.now(),
      );
      owner.stopped.set(key, state);
      owner.ports.interrupted?.({ kind: "stopped", context, ...state });
    }
    error.details = {
      ...error.details,
      reason: owner.stopped.get(key).reason,
      origin: owner.stopped.get(key).origin,
    };
    owner.forgetSources(key, error.code === "locked");
  }
}
