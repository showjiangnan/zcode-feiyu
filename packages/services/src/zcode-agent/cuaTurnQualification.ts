// Modified by ZCode Feiyu contributors (2026).
import type { ComputerUseRuntimeContext } from "@zcode/zcode-cua";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type { ZCodeAgentReadSessionParams } from "./zcodeAgent.js";

type ReadTurnSnapshot = (
  params: ZCodeAgentReadSessionParams,
) => Promise<{ runtime: { activeTurnId?: string } }>;

export function createCuaTurnQualification(readSession: ReadTurnSnapshot, logger: ServiceLogger) {
  return async (context: ComputerUseRuntimeContext): Promise<boolean> => {
    if (!context.workspacePath || !context.turnId) return false;
    try {
      const snapshot = await readSession({
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
        sessionId: context.sessionId,
        deliveryKind: context.deliveryKind,
        runtimePolicy: "existing-only",
        // 真实协议只接受正整数；0 会被拒绝，旧装配把参数错误误判成回合已经结束。
        messageLimit: 1,
      });
      return snapshot.runtime.activeTurnId === context.turnId;
    } catch (error) {
      // 不记录快照或原始异常；查询失败不能冒充 CLI 的回合终态，更不能启动新 Agent。
      const code = (error as { code?: unknown } | null)?.code;
      logger.warn(undefined, "Computer control turn owner query failed", {
        event: "cua.turn_owner.unavailable",
        errorType: error instanceof Error ? error.name : "unknown",
        ...(typeof code === "number" || (typeof code === "string" && /^[\w-]{1,80}$/.test(code))
          ? { code }
          : {}),
      });
      throw Object.assign(new Error("The current task turn could not be verified"), {
        code: "turn_owner_unavailable",
      });
    }
  };
}
