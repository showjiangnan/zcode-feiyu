// Modified by ZCode Feiyu.
import { contextKey, CuaError } from "../domain/protocol.js";

const MAX_RETIRED_TURNS = 2048;
export function rememberEnded(owner, key, context) {
  if (owner.ended.has(key)) {
    if (context?.workspacePath) owner.retiredContexts.get(key).context = context;
    return;
  }
  // 不按时间删除停止事实；没有运行时证明时容量耗尽必须拒绝新资格。
  if (owner.ended.size >= MAX_RETIRED_TURNS) {
    owner.retirementSaturated = true;
    return;
  }
  owner.ended.add(key);
  owner.retiredContexts.set(key, { context, cleanupConfirmed: false });
}
export async function retireEnded(owner) {
  if (!owner.ports.isTurnActive) return;
  for (const [key, record] of owner.retiredContexts) {
    const { context, cleanupConfirmed } = record;
    if (!cleanupConfirmed || !context?.workspacePath || owner.admissions.has(contextKey(context)))
      continue;
    if (!context?.turnId || context.turnId === "*") continue;
    try {
      if (!(await owner.ports.isTurnActive(context))) {
        owner.ended.delete(key);
        owner.retiredContexts.delete(key);
      }
    } catch {
      // Owner 不可达不能当作结束证明，也不能删除现有栅栏。
    }
  }
}
export function assertRetirementAvailable(owner) {
  if (owner.retirementSaturated)
    throw new CuaError(
      "turn_owner_unavailable",
      "Runtime retirement proof is required before accepting more control qualifications",
    );
}
