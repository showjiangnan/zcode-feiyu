// Modified by ZCode Feiyu contributors (2026).
import { CuaError, contextKey } from "../domain/protocol.js";

function assertCurrent(owner, context, signal) {
  signal?.throwIfAborted();
  if (owner.closed) throw new CuaError("disposed", "Computer control service has closed");
  if (
    owner.stopped.has(contextKey(context)) ||
    owner.ended.has(`${context.workspaceKey}\0${context.sessionId}\0${context.turnId}`) ||
    owner.ended.has(`${context.workspaceKey}\0${context.sessionId}\0*`)
  )
    throw new CuaError("turn_stopped", "Computer control is stopped for this turn");
}

export async function findGrant(owner, context, app, grantKey, signal) {
  const authorization = await owner.ports.grantGate?.(context);
  // 开启意图已批准工作区全部应用；旧逐应用记录不再决定资格。异步查询返回后仍要复核关闭/停止。
  if (!(await owner.ports.enabled(context)))
    throw new CuaError("disabled", "Computer control is disabled for this workspace");
  if (owner.ports.isTurnActive && !(await owner.ports.isTurnActive(context)))
    throw new CuaError("turn_ended", "The task runtime no longer owns this turn");
  assertCurrent(owner, context, signal);
  let grant = owner.grants.get(grantKey);
  if (grant?.authorization && authorization?.epoch !== grant.authorization.epoch) {
    await revokeQualification(owner, context);
    throw new CuaError(
      "permission_revoked",
      "Workspace control qualification changed in another window",
    );
  }
  if (!grant) {
    grant = { context, app, authorization, revision: owner.revision };
    owner.grants.set(grantKey, grant);
  }
  return grant;
}

export async function revokeQualification(owner, context) {
  for (const [id, grant] of owner.grants)
    if (contextKey(grant.context) === contextKey(context)) owner.grants.delete(id);
  await owner.stop(context, true);
}
export async function validateContextGrants(owner, context) {
  let current;
  try {
    current = await owner.ports.grantGate?.(context);
  } catch {
    await revokeQualification(owner, context);
    return;
  }
  if (!current) return;
  if (
    [...owner.grants.values()].some(
      (record) =>
        contextKey(record.context) === contextKey(context) &&
        record.authorization?.epoch !== current.epoch,
    )
  )
    await revokeQualification(owner, context);
}

export async function requestApproval(owner, context, app, grantKey, signal) {
  await findGrant(owner, context, app, grantKey, signal);
  return owner.result({ status: "approved", app }, app);
}

// 保留旧可信 RPC 的失败语义，迟到的历史批准不能复活任务；新版本不生成批准请求。
export async function respondToApproval() {
  throw new CuaError("stale_approval", "Application approval dialogs are no longer used");
}
