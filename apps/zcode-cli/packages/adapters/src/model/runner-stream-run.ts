// Modified by ZCode Feiyu.
import type { RunStreamTextInput } from "./runner-stream-state.js";
import { runStreamAttempt } from "./runner-stream-attempt.js";
import { recoverFailedStreamAttempt } from "./runner-stream-failure.js";
import { cleanupStreamAttempt } from "./runner-stream-cleanup.js";
import type {
  StreamRunState,
  StreamAttemptState,
  StreamAttemptContext,
} from "./runner-stream-state.js";
import type { ModelStreamEvent } from "@zcode/contracts";
import { ModelTransportKind as ModelTransportKindValue } from "@zcode/contracts";

import { AccountRequestRetry } from "./account-request-retry.js";

import { classifyModelFailure } from "./failure-classifier.js";
import { unwrapRetryError } from "./failure-inspection.js";

import { repairReasoningHistoryAfterSignatureRejection } from "./reasoning-history-normalization.js";
import { admitAttempt, type AttemptAdmission } from "./request-admission.js";

import { retryAttemptLoopContinues, retryBudgetMaxAttempts } from "./retry-budget.js";

import { isDevelopmentModelIOEnv, shouldRecordModelIO } from "./runner-debug.js";
import { createStreamDiagnostics } from "./runner-diagnostics.js";

import { toAdapterError } from "./runner-retry.js";

import {
  admissionWaitPublishers,
  createAttemptStatusContext,
  createStatusContext,
  publishModelStatus,
  publishModelTelemetryMilestone,
} from "./runner-status.js";
import { modelFailureStatusFields } from "./runner-telemetry.js";
import {
  createLinkedAbortController,
  resolveModelStreamIdleTimeoutMs,
} from "./stream-idle-timeout.js";

import { StreamingToolCallAssembler } from "./streaming-tool-call-assembler.js";

import { statusPublishOptions } from "./runner-stream-status.js";

export async function* runStreamText(input: RunStreamTextInput): AsyncGenerator<ModelStreamEvent> {
  // 重试预算档位：只放宽瞬态失败的放弃条件；
  // `emittedRetryBoundaryEvent` 之后不重试的规则不变。状态事件 maxAttempts 以 0 表示无上限。
  const retryBudget = input.request.modelRetryBudget;
  const statusMaxAttempts = (extraAttempts: number): number =>
    retryBudgetMaxAttempts(retryBudget, input.retry.maxAttempts + extraAttempts);
  const baseStatusContext = createStatusContext({
    maxAttempts: statusMaxAttempts(0),
    request: input.request,
    resolved: input.resolved,
    transport: ModelTransportKindValue.Sse,
  });
  const recordModelIO = shouldRecordModelIO(input.env);
  const isDev = isDevelopmentModelIOEnv(input.env);
  const runState: StreamRunState = {
    requestMessages: input.request.messages,
    signatureRepairAttempted: false,
    emptyCompletionRetryCount: 0,
    physicalAttempt: 0,
  };
  const authRetry = new AccountRequestRetry(input.request, input.resolved, input.logger);

  for (
    let attempt = 1;
    retryAttemptLoopContinues(
      retryBudget,
      attempt,
      input.retry.maxAttempts + Number(runState.signatureRepairAttempted) + authRetry.extraAttempts,
    );
    attempt += 1
  ) {
    const retryBudgetAttempt =
      attempt - Number(runState.signatureRepairAttempted) - authRetry.extraAttempts;
    const startedAt = Date.now();
    // SSE idle timeout 后的重试如果仍固定首请求窗口，容易被同一段 provider 静默窗口反复打断；
    // core recovery 和 adapter 内部 retry 都统一按重试次数每次增加 30s。
    const streamIdleTimeoutMs = resolveModelStreamIdleTimeoutMs({
      baseTimeoutMs: input.streamIdleTimeoutMs,
      retryNumber: (input.request.streamIdleTimeoutRetryNumber ?? 0) + retryBudgetAttempt - 1,
    });
    const pendingRetrySafeEvents: ModelStreamEvent[] = [];
    const diagnostics = createStreamDiagnostics();
    const attemptAbortController = createLinkedAbortController(input.request.abortSignal);
    const attemptRequest = {
      ...input.request,
      abortSignal: attemptAbortController.signal,
      messages: runState.requestMessages,
    };
    const state: StreamAttemptState = {
      emittedEvent: false,
      emittedRetryBoundaryEvent: false,
      emittedError: false,
      retryScheduledFromStreamChunk: false,
      offPeakQueueHoldFromStreamChunk: false,
      statusContext: createAttemptStatusContext(
        {
          ...baseStatusContext,
          maxAttempts: statusMaxAttempts(
            Number(runState.signatureRepairAttempted) + authRetry.extraAttempts,
          ),
        },
        ++runState.physicalAttempt,
      ),
      streamReachedNaturalEnd: false,
      attemptFailed: false,
      awaitIteratorClose: false,
      terminalStatusPublished: false,
      requestHeaders: {},
      requestHeaderCount: 0,
      resolved: input.resolved,
      streamMaxIdleMs: 0,
      streamStallCount: 0,
      streamOutputCommitted: false,
    };
    const toolCallAssembler = new StreamingToolCallAssembler({ logger: input.logger });
    const repairThinkingSignatureRejection = (error: unknown): boolean => {
      if (runState.signatureRepairAttempted || state.resolved.providerKind !== "anthropic") {
        return false;
      }
      const repairedMessages = repairReasoningHistoryAfterSignatureRejection(
        runState.requestMessages,
        error,
      );
      if (!repairedMessages) return false;

      // 签名只对生成它的 thinking block 有效。流尚未提交输出时，只替换
      // 本次请求副本，并给一次不占普通 retry 预算且拥有新 requestId 的物理请求机会；
      // 不能把清理结果写回 canonical history。
      runState.signatureRepairAttempted = true;
      runState.requestMessages = repairedMessages;
      input.logger?.warn("Retrying model stream after thinking signature rejection", {
        attempt,
        event: "model.reasoning_signature_repair.retry",
        maxAttempts: input.retry.maxAttempts + 1 + authRetry.extraAttempts,
        nextAttempt: attempt + 1,
        requestId: state.statusContext.requestId,
        status: "waiting",
      });
      return true;
    };
    const publishVisibleMilestones = async (observation: {
      contentMs?: number;
      textMs?: number;
    }): Promise<void> => {
      if (state.timeToFirstContentMs === undefined && observation.contentMs !== undefined) {
        state.timeToFirstContentMs = observation.contentMs;
        await publishModelTelemetryMilestone(
          {
            ...state.statusContext,
            attempt,
            elapsedMs: observation.contentMs,
            timestamp: new Date(startedAt + observation.contentMs).toISOString(),
            type: "model_first_content",
          },
          { logger: input.logger, statusSink: input.statusSink },
        );
      }
      if (state.timeToFirstTextMs === undefined && observation.textMs !== undefined) {
        state.timeToFirstTextMs = observation.textMs;
        await publishModelTelemetryMilestone(
          {
            ...state.statusContext,
            attempt,
            elapsedMs: observation.textMs,
            timestamp: new Date(startedAt + observation.textMs).toISOString(),
            type: "model_first_text",
          },
          { logger: input.logger, statusSink: input.statusSink },
        );
      }
    };

    // 进程级准入：每次尝试发出前等槽位，
    // 票据在本次尝试结束时归还（成功 / 失败 / 抛出 / 消费者放弃流都经 finally；退避 sleep 之前先归还）。
    // 等待中被取消 → 与 sleep 被取消同一条路：记 connect 阶段的 cancelled 失败，抛出。
    let admission: AttemptAdmission;
    try {
      admission = await admitAttempt({
        admission: input.request.modelRequestAdmission,
        requestId: state.statusContext.requestId,
        attempt: runState.physicalAttempt,
        model: {
          providerId: String(state.resolved.providerId),
          modelId: String(state.resolved.modelId),
        },
        signal: input.request.abortSignal,
        ...admissionWaitPublishers(state.statusContext, attempt, statusPublishOptions(input)),
      });
    } catch (admitError) {
      attemptAbortController.cleanup();
      const admitFailure = classifyModelFailure(admitError, input.request.abortSignal);
      await publishModelStatus(
        {
          ...state.statusContext,
          attempt,
          durationMs: Date.now() - startedAt,
          message: admitFailure.message,
          reason: admitFailure.reason,
          requestHeaderCount: state.requestHeaderCount,
          requestHeaders: state.requestHeaders,
          retryable: false,
          statusCode: admitFailure.statusCode,
          streamOutputCommitted: state.streamOutputCommitted,
          ...modelFailureStatusFields(admitError, admitFailure, "connect"),
          timestamp: new Date().toISOString(),
          type: "model_request_failed",
        },
        {
          ...statusPublishOptions(input),
          failureError: unwrapRetryError(admitError),
        },
      );
      throw toAdapterError(admitError, admitFailure, state.statusContext, attempt, {
        errorPhase: "connect",
      });
    }

    const context: StreamAttemptContext = {
      input,
      attempt,
      retryBudgetAttempt,
      startedAt,
      streamIdleTimeoutMs,
      pendingRetrySafeEvents,
      diagnostics,
      attemptAbortController,
      attemptRequest,
      toolCallAssembler,
      recordModelIO,
      isDev,
      authRetry,
      statusMaxAttempts,
      retryBudget,
      repairThinkingSignatureRejection,
      publishVisibleMilestones,
      admission,
      runState,
      state,
    };
    try {
      const outcome = yield* runStreamAttempt(context);
      if (outcome === "hold_retry_budget") attempt -= 1;
      if (outcome === "completed") return;
    } catch (error) {
      if (await recoverFailedStreamAttempt(context, error)) attempt -= 1;
    } finally {
      await cleanupStreamAttempt({ ...context, attempt });
    }
  }
}
