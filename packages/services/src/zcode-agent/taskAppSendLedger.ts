// Modified by ZCode Feiyu contributors (2026).
import { createHash } from "node:crypto";

/** 与 CLI 每会话幂等表同量级；超出后淘汰最久未用的记录。 */
const SEND_LEDGER_LIMIT = 512;

export interface TaskAppSendPayload {
  taskId: string;
  message: string;
  delivery: "auto" | "queue";
}

export type TaskAppSendCheck = "new" | "same" | "conflict";

/**
 * 发送端的幂等护栏：记住本 Host 进程发出过的命令 ID 对应的载荷指纹，用来拒绝「同 ID 不同载荷」。
 * 它不是命令事实的所有者——命令是否被接收、执行仍只以 CLI 的回执与查询为准；
 * 没有记录（进程重启、被淘汰）时不给出任何意见，交给 CLI 的幂等结果处理。
 * causalContext 由发送端 runtime 在提交时注入，重试时可能已变化，因此不进入指纹。
 */
export function createTaskAppSendLedger(limit = SEND_LEDGER_LIMIT) {
  const fingerprints = new Map<string, string>();
  return {
    /** conflict 不改动记录；new / same 都把该 ID 刷新为最近使用。 */
    check(scope: string, commandId: string, payload: TaskAppSendPayload): TaskAppSendCheck {
      const key = `${scope}\0${commandId}`;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([payload.taskId, payload.delivery, payload.message]))
        .digest("hex");
      const known = fingerprints.get(key);
      if (known !== undefined && known !== fingerprint) return "conflict";
      fingerprints.delete(key);
      fingerprints.set(key, fingerprint);
      if (fingerprints.size > limit) fingerprints.delete(fingerprints.keys().next().value!);
      return known === undefined ? "new" : "same";
    },
  };
}

export type TaskAppSendLedger = ReturnType<typeof createTaskAppSendLedger>;
