// Modified by ZCode Feiyu.
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import { runWithSessionResidencyFinalization } from "../../../zcode-protocol/session-residency.js";
import type { CommandEnvelope, CommandResult } from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import { inputIntentMetadata } from "../input-intent.js";
import type { SteerTurnOptions } from "../../../app/types.js";
import {
  enqueueDeferredInputForBusyWork,
  V4InputAdmissionRejectedError,
} from "../input-admission.js";

/** goal/compact 组的裁决拒绝（gateway 捕获后进 ACK failed，message 透传给客户端）。 */
export class V4GoalCompactRejectedError extends Error {
  constructor(
    readonly reasonCode:
      | "activeTurn"
      | "compactOperationLock"
      | "restoreWarning"
      | "guard.planGoalMutuallyExclusive"
      | "emptyObjective",
    message: string,
  ) {
    super(message);
    this.name = "V4GoalCompactRejectedError";
  }
}

// 手动 compact 在后台 turn 真正登记前，下一条 command 已可能完成 admission。
// 仅看 runtime activeTurn 会留下一个极短的重复 compact 窗口；controller WeakSet 只补齐
// operation lock 的同步边界，不复制 queue 或 lifecycle 业务状态。
export const manualCompactControllers = new WeakSet<AbortController>();

export async function runCompactTurnInBackground(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    abortController: AbortController;
    foregroundPromotionLeaseId?: string;
    inputId: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  let mutationReason = "session_compacted";
  let lifecycleStatus: "success" | "failed" | "cancelled" = "success";
  host.logger?.info?.("v4 background compact started", {
    inputId: params.inputId,
    sessionId: record.app.sessionId,
    workspacePath: record.workspace.workspacePath,
  });
  try {
    await record.app.submitPrompt("/compact", {
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
    });
  } catch (error) {
    lifecycleStatus = params.abortController.signal.aborted ? "cancelled" : "failed";
    mutationReason =
      lifecycleStatus === "cancelled" ? "session_compact_cancelled" : "session_compact_failed";
    if ((host.getQueueLength?.(record.app.sessionId) ?? 0) > 0) {
      try {
        // queued compact 是 FIFO barrier；失败/Stop 后若继续 auto-drain，
        // 后续文本会越过用户显式维护意图。与普通 Stop 一致切为 held。
        await record.app.setQueueAutoDrain(false);
      } catch (holdError) {
        host.logger?.warn?.("v4 compact failed to hold following queue", {
          error: holdError instanceof Error ? holdError.message : String(holdError),
          inputId: params.inputId,
          sessionId: record.app.sessionId,
        });
      }
    }
    host.logger?.warn?.("v4 background compact failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } finally {
    if (params.foregroundPromotionLeaseId) {
      record.app.runtime.releaseForegroundPromotionLease(params.foregroundPromotionLeaseId);
    }
    manualCompactControllers.delete(params.abortController);
    if (record.activeAbortController === params.abortController) {
      // ready 边界（关键约束）：compact 结束后必须先释放 active lock 再广播；
      // 否则 queued prompt 或后续 /compact 会在 ready 边界短暂撞上旧 controller。
      record.activeAbortController = undefined;
    }
  }
  try {
    // compact 没有 user message，不能依赖 SessionInputPromoted 解 pin；无论 lifecycle
    // 成功/失败/取消，都用 timeline command fact 阻止重启后把已执行命令再次提示重放。
    await host.recordPersistentCommandFact?.(
      record.app.sessionId,
      "timeline",
      {
        commandId: params.inputId,
        status: "accepted",
        revisionAtDecision: 0,
      },
      { lifecycleStatus },
    );
  } catch (error) {
    // compact 已执行，不能因查重旁路写失败伪装为模型执行失败。
    host.logger?.warn?.("v4 compact persistent command fact failed", {
      commandId: params.inputId,
      error: error instanceof Error ? error.message : String(error),
      sessionId: record.app.sessionId,
    });
  }
  // 旧协议路径在此调 afterStateMutation → 用钩子等价替代（随旧广播删除）。
  await host.afterLegacyStateMutation?.(record, mutationReason);
}

/** queue promotion 与直接命令共用唯一手动 compact 启动路径。 */
export async function startManualCompact(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  inputId: string,
  foregroundPromotionLeaseId?: string,
): Promise<void> {
  if (record.restoreWarning) {
    throw new V4GoalCompactRejectedError("restoreWarning", record.restoreWarning.message);
  }
  // 冷恢复后用户可能直接触发 /compact（不先经 sendText），compact 的后台模型请求
  // 同样需要模型就绪检查——钩子（见 types.ts）。
  await host.ensureModelReady?.(record);
  const abortController = new AbortController();
  // compact 的真实模型请求在后台执行，但 Stop 仍通过
  // record.activeAbortController 中断。不登记 controller，压缩中的请求会跑到自然结束。
  record.activeAbortController = abortController;
  manualCompactControllers.add(abortController);
  void runWithSessionResidencyFinalization(record, () =>
    runCompactTurnInBackground(host, record, {
      abortController,
      foregroundPromotionLeaseId,
      inputId,
    }),
  ).catch(() => {
    // 后台 compact 的错误经事件流（CompactStarted/终态 marker）降级上报；兜底防 unhandled rejection。
  });
}

/**
 * compact：手动上下文压缩（v4 payload 为空对象，无 instructions 变体）。
 *
 * barrier 语义：
 * 1. running/goal verifier/goal continuation/tool work → typed compact intent 入 FIFO。
 * 2. held queue → 追加队尾，不绕过既有 future intent。
 * 3. running 或 queued compact 已存在 → compactOperationLock，禁止重复压缩。
 */
export async function compact(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  const activeTurn = record.app.runtime.getActiveTurnInfo();
  const activeController = record.activeAbortController;
  if (
    activeTurn?.kind === "compact" ||
    (activeController ? manualCompactControllers.has(activeController) : false) ||
    host.hasQueueItemKind?.(record.app.sessionId, "compact")
  ) {
    host.logger?.info?.("v4 compact already running or queued, rejected", {
      commandId: envelope.commandId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
    throw new V4GoalCompactRejectedError(
      "compactOperationLock",
      "Compact is already running or queued",
    );
  }
  if (record.restoreWarning) {
    // 与 prompt-turn 相同的闸门：恢复失败的会话不能静默续写（含 compact turn）。
    throw new V4GoalCompactRejectedError("restoreWarning", record.restoreWarning.message);
  }

  const routingMode = host.getInputRoutingMode?.(record.app.sessionId) ?? null;
  const busy = Boolean(record.activeAbortController) || Boolean(activeTurn);
  if (busy || routingMode === "enqueue" || routingMode === "guide" || routingMode === "choice") {
    const intent = inputIntentMetadata(envelope, {
      requestedDelivery: "queue",
      text: "/compact",
    });
    const queueOptions = {
      commandKind: "compact" as const,
      inputId: envelope.commandId,
      intent,
      queryId: envelope.commandId as NonNullable<SteerTurnOptions["queryId"]>,
    };
    if (await enqueueDeferredInputForBusyWork(record, "/compact", queueOptions)) {
      return undefined;
    }
    const queued = await record.app.steerTurn("/compact", {
      ...queueOptions,
      delivery: "queue",
    });
    if (queued.kind === "rejected") {
      throw new V4InputAdmissionRejectedError(
        queued.reason === "input_too_large"
          ? "proto.payloadTooLarge"
          : queued.reason === "empty_input"
            ? "proto.invalidPayload"
            : "fault.command.inputRejected",
        `compact input queue rejected: ${queued.reason}`,
      );
    }
    return undefined;
  }

  await startManualCompact(host, record, envelope.commandId);
  return undefined;
}

export function goalCommandQueueText(displayText: string | undefined, objective: string): string {
  const trimmed = displayText?.trim();
  return trimmed ? trimmed : `/goal ${objective}`;
}
