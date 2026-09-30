// Modified by ZCode Feiyu contributors (2026).
import { computeAutomationNextRunAt, type AutomationRepo } from "@zcode/services/node";
import type { ZCodeAutomationTrigger } from "@zcode/shared";
import type { MainToSchedulerMessage } from "./schedulerProtocol.js";

export interface CronDispatchContext {
  automationId: string;
  workspaceKey: string;
  trigger: ZCodeAutomationTrigger;
  hostReadySequence: number;
}

/** 与既有 manual claim release 共用 scheduler 结算路径，不创建第二份 run 状态。 */
export async function settleCronDispatchResult(
  params: {
    repo: AutomationRepo;
    inFlight: Map<string, CronDispatchContext>;
    hostReadyWake: ReturnType<typeof createHostReadyWakeCoordinator>;
    logError(message: string): void;
  },
  msg: Extract<MainToSchedulerMessage, { type: "cron-dispatch-result" }>,
): Promise<void> {
  const { repo, inFlight, hostReadyWake } = params;
  const context = inFlight.get(msg.runId);
  inFlight.delete(msg.runId);
  const savedRun = await repo.getRun(msg.runId);
  // 已结算的运行不接受迟到的失败/等待回执，避免释放下一次运行的认领。
  if (!savedRun || savedRun.dispatchStatus === "dispatched") return;
  const now = Date.now();
  const automationId = savedRun.automationId;
  const workspaceKey = context?.workspaceKey ?? savedRun.workspaceKey;
  const trigger = savedRun.trigger;
  if (msg.ok) {
    if (trigger === "manual") {
      await repo.markManualRunDispatched({
        runId: msg.runId,
        sessionId: msg.sessionId ?? null,
        dispatchedAt: now,
      });
      return;
    }
    const automation = await repo.get(automationId);
    const nextRunAt = automation ? computeAutomationNextRunAt(automation, now) : null;
    await repo.markDispatched(automationId, {
      dispatchedAt: now,
      nextRunAt,
      runId: msg.runId,
      sessionId: msg.sessionId ?? null,
    });
    return;
  }
  if (msg.failureKind === "waiting_for_host") {
    await hostReadyWake.settleWaiting(
      context?.hostReadySequence ?? hostReadyWake.sequence(),
      () => repo.markWaitingForHost({ automationId, runId: msg.runId, now, trigger }),
      now,
    );
    return;
  }
  await repo.markRunDispatch({
    runId: msg.runId,
    dispatchStatus: "failed_to_dispatch",
    error: msg.error ?? "dispatch failed",
  });
  if (trigger === "manual") {
    await settleManualClaimForDispatchResult({
      repo,
      automationId,
      runId: msg.runId,
      workspaceKey,
      ok: false,
      logError: params.logError,
    });
    return;
  }
  await repo.markDispatchFailed(automationId, {
    failedAt: now,
    error: msg.error ?? "dispatch failed",
    kind: msg.failureKind ?? "transient",
    nextRunAt: await repo
      .get(automationId)
      .then((automation) => (automation ? computeAutomationNextRunAt(automation, now) : null)),
  });
}

/** Host-ready 是通知序号而非可用性缓存；结算后重查序号避免 ready 早于 waiting 写入丢唤醒。 */
export function createHostReadyWakeCoordinator(
  repo: {
    releaseWaitingForHost(now: number): Promise<number>;
  },
  requestTick: () => void,
) {
  let sequence = 0;
  return {
    sequence: () => sequence,
    async hostReady(now: number): Promise<void> {
      sequence += 1;
      await repo.releaseWaitingForHost(now);
      requestTick();
    },
    async settleWaiting(
      dispatchedSequence: number,
      markWaiting: () => Promise<void>,
      now: number,
    ): Promise<void> {
      await markWaiting();
      if (sequence > dispatchedSequence) await repo.releaseWaitingForHost(now);
    },
  };
}

interface ManualClaimReleaseRepo {
  get(automationId: string): Promise<{ workspaceKey: string } | null>;
  getRun(runId: string): Promise<{ workspaceKey: string } | null>;
  releaseManualClaim(automationId: string, workspaceKey: string): Promise<void>;
}

interface ManualClaimReleaseParams {
  repo: ManualClaimReleaseRepo;
  automationId: string;
  runId: string;
  workspaceKey?: string;
  logError: (message: string) => void;
}

async function releaseManualClaimForSettledRun(params: ManualClaimReleaseParams): Promise<void> {
  const releaseWorkspaceKey =
    params.workspaceKey ??
    (await params.repo.getRun(params.runId).then((run) => run?.workspaceKey)) ??
    (await params.repo.get(params.automationId).then((automation) => automation?.workspaceKey));
  if (!releaseWorkspaceKey) {
    params.logError(
      `manual claim release skipped: workspaceKey missing automation=${params.automationId} runId=${params.runId}`,
    );
    return;
  }
  // scheduler 重启 / inFlight 丢失后仍可能收到 main 的迟到回报；manual
  // single-flight 锁必须用 run 台账或 automation 兜回 workspaceKey，否则会卡到 stale 回收。
  await params.repo.releaseManualClaim(params.automationId, releaseWorkspaceKey);
}

export async function settleManualClaimForDispatchResult(
  params: ManualClaimReleaseParams & { ok: boolean },
): Promise<void> {
  // host ok 只表示 prompt accepted/queued，真实终态由 host subscription
  // 收口；scheduler 仅在派发失败、没有可等待 turn 时释放 manual claim。
  if (params.ok) return;
  await releaseManualClaimForSettledRun(params);
}
