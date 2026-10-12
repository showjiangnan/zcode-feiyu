// Modified by ZCode Feiyu.
import {
  ModelErrorCode,
  ModelFailureReason as ModelFailureReasonValue,
  ModelProtocolError,
  ModelRetryReason,
} from "@zcode/contracts";

import { classifyModelFailure, type ClassifiedModelFailure } from "./failure-classifier.js";
import { getResponseHeaders, unwrapRetryError } from "./failure-inspection.js";

import { offPeakTicketExpiredMessage, resolveOffPeakFailureDecision } from "./offpeak-retry.js";

import { recordStreamTextDebug } from "./runner-debug.js";
import { logStreamFailureDiagnostics } from "./runner-diagnostics.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";

import {
  calculateRetryDelay,
  logRetryDelayDecision,
  sleep,
  TerminalStreamChunkError,
  toAdapterError,
} from "./runner-retry.js";
import { RuntimeHeadersRefreshError } from "./runner-runtime-headers.js";

import { publishModelStatus } from "./runner-status.js";
import { modelFailureStatusFields, readModelFailureErrorPhase } from "./runner-telemetry.js";

import { statusPublishOptions, publishRetryScheduledStatus } from "./runner-stream-status.js";

import { resolveStreamFailureDecision } from "./runner-stream-failure-policy.js";

import type { StreamAttemptContext } from "./runner-stream-state.js";
export async function recoverFailedStreamAttempt(
  context: StreamAttemptContext,
  error: unknown,
): Promise<boolean> {
  const {
    input,
    attempt,
    retryBudgetAttempt,
    startedAt,
    diagnostics,
    attemptRequest,
    toolCallAssembler,
    recordModelIO,
    isDev,
    authRetry,
    statusMaxAttempts,
    retryBudget,
    repairThinkingSignatureRejection,
    admission,
    runState,
    state,
  } = context;

  state.attemptFailed = true;
  if (recordModelIO && state.options) {
    await recordStreamTextDebug({
      modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
      attempt,
      debugDir: input.debugDir,
      error,
      isDev,
      normalizedToolCalls: toolCallAssembler.snapshotNormalizedToolCalls(),
      options: state.options,
      recordModelIO,
      request: attemptRequest,
      requestId: state.statusContext.requestId,
      resolved: state.resolved,
      result: state.result,
      startedAt,
    });
  }
  if (error instanceof TerminalStreamChunkError) {
    state.awaitIteratorClose = true;
    throw error.adapterError;
  }
  if (
    error instanceof ModelProtocolError &&
    error.code === ModelErrorCode.ModelRequestAuthMissing
  ) {
    // stream 在 attempt try 内解析请求鉴权，过去会把网络前的类型化
    // 鉴权缺失错误重新归一化为通用请求失败；generate 则直接保留原始协议错误。
    throw error;
  }

  const completedAt = Date.now();
  const retryWithRepairedHistory =
    !state.emittedRetryBoundaryEvent && repairThinkingSignatureRejection(error);
  if (retryWithRepairedHistory) {
    state.statusContext = {
      ...state.statusContext,
      maxAttempts: statusMaxAttempts(1 + authRetry.extraAttempts),
    };
  }
  const classified = classifyModelFailure(error, input.request.abortSignal);
  if (error instanceof RuntimeHeadersRefreshError) {
    classified.message = error.message;
    classified.retryable = false;
  }
  // off-peak 特判（仅 idle plan provider）：排队 429 豁免预算无限探测；3102 标记落败触发续跑。
  const offPeak = resolveOffPeakFailureDecision({
    offPeak: state.resolved.accountAccess?.mode === "off-peak",
    failure: classified,
    error: unwrapRetryError(error),
  });
  const failure: ClassifiedModelFailure =
    offPeak?.kind === "ticketExpired"
      ? {
          ...classified,
          retryable: false,
          message: offPeakTicketExpiredMessage(classified.message),
        }
      : offPeak?.kind === "queued"
        ? {
            ...classified,
            retryable: true,
            retryReason: ModelRetryReason.OffpeakQueued,
          }
        : classified;
  const errorPhase =
    readModelFailureErrorPhase(error) ??
    (state.streamIterator === undefined ? "prepare" : "stream");
  state.awaitIteratorClose = failure.reason !== ModelFailureReasonValue.Cancelled;
  const responseHeaders = sanitizeModelNetworkHeaders(getResponseHeaders(unwrapRetryError(error)));
  const failureDecision = resolveStreamFailureDecision({
    attempt: retryBudgetAttempt,
    emittedRetryBoundaryEvent: state.emittedRetryBoundaryEvent,
    error,
    failure,
    maxAttempts: input.retry.maxAttempts,
    preserveProviderStreamBoundaries: input.request.preserveProviderStreamBoundaries,
    responseHeaders,
    retryBudget,
    streamIteratorCreated: state.streamIterator !== undefined,
    streamErrorChunkObserved: Boolean(diagnostics.lastErrorChunk || diagnostics.lastFinishChunk),
  });
  const retryWithAuth = authRetry.claim(
    error,
    state.options === undefined ||
      state.emittedRetryBoundaryEvent ||
      state.streamOutputCommitted ||
      (input.request.preserveProviderStreamBoundaries === true &&
        failureDecision.context?.streamFailurePhase === "response_body"),
  );
  if (retryWithAuth) {
    failureDecision.canRetry = true;
    state.statusContext = {
      ...state.statusContext,
      maxAttempts: statusMaxAttempts(
        Number(runState.signatureRepairAttempted) + authRetry.extraAttempts,
      ),
    };
  }
  // off-peak 排队 429 豁免预算：不消耗 maxAttempts，SSE 可见输出边界仍适用。
  if (offPeak?.kind === "queued" && !state.emittedRetryBoundaryEvent) {
    failureDecision.canRetry = true;
  }
  if (retryWithRepairedHistory) {
    failureDecision.canRetry = true;
  }

  logStreamFailureDiagnostics({
    attempt,
    canRetry: failureDecision.canRetry,
    diagnostics,
    durationMs: completedAt - startedAt,
    emittedError: state.emittedError,
    emittedEvent: state.emittedEvent,
    emittedRetryBoundaryEvent: state.emittedRetryBoundaryEvent,
    error,
    failure,
    logger: input.logger,
    statusContext: state.statusContext,
  });
  await publishModelStatus(
    {
      ...state.statusContext,
      attempt,
      durationMs: completedAt - startedAt,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: state.requestHeaderCount,
      requestHeaders: state.requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      retryable: failureDecision.canRetry,
      statusCode: failure.statusCode,
      streamOutputCommitted: state.streamOutputCommitted,
      ...modelFailureStatusFields(error, failure, errorPhase),
      timestamp: new Date(completedAt).toISOString(),
      type: "model_request_failed",
    },
    {
      ...statusPublishOptions(input, admission),
      failureError: unwrapRetryError(error),
    },
  );
  state.terminalStatusPublished = true;

  if (retryWithAuth) {
    await publishRetryScheduledStatus(
      input,
      state.statusContext,
      attempt,
      0,
      { ...failure, retryReason: ModelRetryReason.AuthRefresh },
      state.requestHeaders,
      responseHeaders,
    );
    return false;
  }
  if (retryWithRepairedHistory) {
    await publishRetryScheduledStatus(
      input,
      state.statusContext,
      attempt,
      0,
      {
        ...failure,
        retryReason: ModelRetryReason.ReasoningSignatureRepair,
      },
      state.requestHeaders,
      responseHeaders,
      admission,
    );
    return false;
  }

  if (!failureDecision.canRetry) {
    logRetryDelayDecision({
      attempt,
      canRetry: failureDecision.canRetry,
      failure,
      logger: input.logger,
      responseHeaders,
      statusContext: state.statusContext,
    });
    throw toAdapterError(error, failure, state.statusContext, attempt, {
      ...failureDecision.context,
      errorPhase,
    });
  }

  const delayMs =
    offPeak?.kind === "queued"
      ? offPeak.delayMs
      : calculateRetryDelay(input.retry, retryBudgetAttempt, failure.retryAfterMs);
  logRetryDelayDecision({
    attempt,
    canRetry: failureDecision.canRetry,
    delayMs,
    failure,
    logger: input.logger,
    responseHeaders,
    statusContext: state.statusContext,
  });

  await publishRetryScheduledStatus(
    input,
    state.statusContext,
    attempt,
    delayMs,
    failure,
    state.requestHeaders,
    responseHeaders,
    admission,
  );
  // 退避期间不持票：槽位让给别人，重试再准入。
  await admission.release();
  try {
    await sleep(delayMs, input.request.abortSignal);
  } catch (sleepError) {
    const sleepFailure = classifyModelFailure(sleepError, input.request.abortSignal);
    await publishModelStatus(
      {
        ...state.statusContext,
        attempt,
        durationMs: Date.now() - startedAt,
        message: sleepFailure.message,
        reason: sleepFailure.reason,
        requestHeaderCount: state.requestHeaderCount,
        requestHeaders: state.requestHeaders,
        retryable: false,
        statusCode: sleepFailure.statusCode,
        streamOutputCommitted: state.streamOutputCommitted,
        ...modelFailureStatusFields(sleepError, sleepFailure, "connect"),
        timestamp: new Date().toISOString(),
        type: "model_request_failed",
      },
      {
        // 退避期间票据已归还：这次取消不属于任何一次尝试，不转投票据。
        ...statusPublishOptions(input),
        failureError: unwrapRetryError(sleepError),
      },
    );
    state.terminalStatusPublished = true;
    throw toAdapterError(sleepError, sleepFailure, state.statusContext, attempt, {
      errorPhase: "connect",
    });
  }
  if (offPeak?.kind === "queued") {
    // 排队等待不消耗重试预算：回退计数让 for 自增后原地重试，无限探测。
    return true;
  }

  return false;
}
