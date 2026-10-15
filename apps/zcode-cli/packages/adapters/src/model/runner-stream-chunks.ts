// Modified by ZCode Feiyu.
import type { Logger, ModelStatusSink, ModelStreamEvent } from "@zcode/contracts";
import { ModelRetryReason } from "@zcode/contracts";
import type { TextStreamPart, ToolSet } from "ai";

import { classifyModelFailure, type ClassifiedModelFailure } from "./failure-classifier.js";
import { getResponseHeaders, unwrapRetryError } from "./failure-inspection.js";

import { offPeakTicketExpiredMessage, resolveOffPeakFailureDecision } from "./offpeak-retry.js";
import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";

import { type AttemptAdmission } from "./request-admission.js";
import { isRequestVerificationRejection } from "./request-security-edition/recovery.js";
import { retryBudgetMaxAttempts } from "./retry-budget.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";

import {
  createStreamDiagnostics,
  logIgnoredStreamChunk,
  recordStreamChunkDiagnostic,
} from "./runner-diagnostics.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import { toModelStreamEvent } from "./runner-normalization.js";

import {
  calculateRetryDelay,
  logRetryDelayDecision,
  sleep,
  TerminalStreamChunkError,
  toAdapterError,
} from "./runner-retry.js";

import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "./runner-runtime.js";
import { createStatusContext, publishModelStatus } from "./runner-status.js";
import { modelFailureStatusFields } from "./runner-telemetry.js";

import { StreamingToolCallAssembler } from "./streaming-tool-call-assembler.js";

import {
  isRawProviderRetryBoundaryEvent,
  toProviderStreamBoundaryEvent,
  applyStreamEventsToRetryBoundary,
  streamChunkResult,
} from "./runner-stream-boundary.js";
import { resolveStreamFailureDecision } from "./runner-stream-failure-policy.js";
import { statusPublishOptions, publishRetryScheduledStatus } from "./runner-stream-status.js";

export async function handleStreamChunk(input: {
  /** 本次尝试的准入：错误块的退避 sleep 之前先归还。 */
  admission: AttemptAdmission;
  attempt: number;
  chunk: TextStreamPart<ToolSet>;
  diagnostics: ReturnType<typeof createStreamDiagnostics>;
  emittedRetryBoundaryEvent: boolean;
  input: {
    logger?: Logger;
    request: AiSdkModelTextRequest;
    resolved: ResolvedAiSdkModel;
    retry: ResolvedAiSdkModelRetryOptions;
    statusSink?: ModelStatusSink;
  };
  pendingRetrySafeEvents: ModelStreamEvent[];
  repairThinkingSignatureRejection: (error: unknown) => boolean;
  canRecoverProjectToken: (error: unknown) => boolean;
  retryBudgetAttempt: number;
  requestHeaderCount: number;
  requestHeaders: Record<string, string>;
  startedAt: number;
  statusContext: ReturnType<typeof createStatusContext>;
  toolCallAssembler: StreamingToolCallAssembler;
}): Promise<{
  emittedError: boolean;
  emittedEvent: boolean;
  emittedRetryBoundaryEvent: boolean;
  retryScheduled: boolean;
  /** off-peak 排队重试：外层 for 冻结 attempt 预算。 */
  offPeakQueueHold: boolean;
  terminalError?: TerminalStreamChunkError;
  visibleEvents: ModelStreamEvent[];
}> {
  recordStreamChunkDiagnostic(input.diagnostics, input.chunk);
  const providerEventObserved =
    input.input.request.preserveProviderStreamBoundaries === true &&
    isRawProviderRetryBoundaryEvent(input.chunk);
  const providerBoundaryEvent = input.input.request.preserveProviderStreamBoundaries
    ? toProviderStreamBoundaryEvent(input.chunk)
    : undefined;
  const emittedRetryBoundaryEvent = input.emittedRetryBoundaryEvent || providerEventObserved;
  const providerBusinessFinishError = detectProviderBusinessFinishError({
    providerId: String(input.statusContext.providerId),
    providerKind: input.statusContext.providerKind,
    source: input.chunk,
  });
  if (providerBusinessFinishError) {
    return handleStreamErrorEvent(
      { ...input, emittedRetryBoundaryEvent },
      providerBusinessFinishError,
    );
  }
  const event = toModelStreamEvent(input.chunk);
  if (event?.type === "finish" && input.input.resolved.rawRequestBodyCapture?.modelSpeed) {
    event.usage = {
      ...event.usage,
      modelSpeed: { ...input.input.resolved.rawRequestBodyCapture.modelSpeed },
    };
  }
  if (event?.type === "error") {
    return handleStreamErrorEvent({ ...input, emittedRetryBoundaryEvent }, event.error);
  }
  if (!event) {
    if (providerEventObserved) {
      // raw provider event 只用于结束 compact SSE retry；它本身不属于
      // 可见正文；只投影 response/block/stop 的语义边界，并立即刷出已暂存的 synthetic start。
      return applyStreamEventsToRetryBoundary({
        emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
        events: providerBoundaryEvent ? [providerBoundaryEvent] : [],
        pendingRetrySafeEvents: input.pendingRetrySafeEvents,
        providerEventObserved: true,
        preserveProviderStreamBoundaries: true,
      });
    }
    logIgnoredStreamChunk({
      attempt: input.attempt,
      chunk: input.chunk,
      logger: input.input.logger,
      statusContext: input.statusContext,
    });
    return streamChunkResult();
  }

  return applyStreamEventsToRetryBoundary({
    emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
    events: input.toolCallAssembler.handle(event),
    pendingRetrySafeEvents: input.pendingRetrySafeEvents,
    providerEventObserved,
    preserveProviderStreamBoundaries: input.input.request.preserveProviderStreamBoundaries,
  });
}

export async function handleStreamErrorEvent(
  input: Parameters<typeof handleStreamChunk>[0],
  error: unknown,
): Promise<Awaited<ReturnType<typeof handleStreamChunk>>> {
  if (isRequestVerificationRejection(error) || input.canRecoverProjectToken(error)) throw error;
  const retryWithRepairedHistory =
    !input.emittedRetryBoundaryEvent && input.repairThinkingSignatureRejection(error);
  const statusContext = retryWithRepairedHistory
    ? {
        ...input.statusContext,
        maxAttempts: retryBudgetMaxAttempts(
          input.input.request.modelRetryBudget,
          input.input.retry.maxAttempts + 1,
        ),
      }
    : input.statusContext;
  const classified = classifyModelFailure(error, input.input.request.abortSignal);
  // off-peak 特判：SSE 首块即错（尚无可见输出）时的排队 429 同样豁免预算重试。
  const offPeak = resolveOffPeakFailureDecision({
    offPeak: input.input.resolved.accountAccess?.mode === "off-peak",
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
  const responseHeaders = sanitizeModelNetworkHeaders(getResponseHeaders(unwrapRetryError(error)));
  const failureDecision = resolveStreamFailureDecision({
    attempt: input.retryBudgetAttempt,
    emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
    error,
    failure,
    maxAttempts: input.input.retry.maxAttempts,
    preserveProviderStreamBoundaries: input.input.request.preserveProviderStreamBoundaries,
    responseHeaders,
    retryBudget: input.input.request.modelRetryBudget,
    streamErrorChunkObserved: true,
  });
  // off-peak 排队 429 豁免预算：不消耗 maxAttempts，SSE 可见输出边界仍适用。
  if (offPeak?.kind === "queued" && !input.emittedRetryBoundaryEvent) {
    failureDecision.canRetry = true;
  }
  if (retryWithRepairedHistory) {
    failureDecision.canRetry = true;
  }
  await publishModelStatus(
    {
      ...statusContext,
      attempt: input.attempt,
      durationMs: Date.now() - input.startedAt,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: input.requestHeaderCount,
      requestHeaders: input.requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      retryable: failureDecision.canRetry,
      statusCode: failure.statusCode,
      streamOutputCommitted: input.emittedRetryBoundaryEvent,
      ...modelFailureStatusFields(error, failure, "stream"),
      timestamp: new Date().toISOString(),
      type: "model_request_failed",
    },
    {
      ...statusPublishOptions(input.input, input.admission),
      failureError: unwrapRetryError(error),
    },
  );

  if (retryWithRepairedHistory) {
    await publishRetryScheduledStatus(
      input.input,
      statusContext,
      input.attempt,
      0,
      {
        ...failure,
        retryReason: ModelRetryReason.ReasoningSignatureRepair,
      },
      input.requestHeaders,
      responseHeaders,
      input.admission,
    );
    return streamChunkResult({
      emittedError: true,
      retryScheduled: true,
    });
  }

  if (!failureDecision.canRetry) {
    logRetryDelayDecision({
      attempt: input.attempt,
      canRetry: failureDecision.canRetry,
      failure,
      logger: input.input.logger,
      responseHeaders,
      statusContext,
    });
    return streamChunkResult({
      emittedError: true,
      terminalError: new TerminalStreamChunkError(
        toAdapterError(error, failure, statusContext, input.attempt, {
          ...failureDecision.context,
          errorPhase: "stream",
        }),
      ),
    });
  }

  const delayMs =
    offPeak?.kind === "queued"
      ? offPeak.delayMs
      : calculateRetryDelay(input.input.retry, input.retryBudgetAttempt, failure.retryAfterMs);
  logRetryDelayDecision({
    attempt: input.attempt,
    canRetry: failureDecision.canRetry,
    delayMs,
    failure,
    logger: input.input.logger,
    responseHeaders,
    statusContext,
  });

  await publishRetryScheduledStatus(
    input.input,
    statusContext,
    input.attempt,
    delayMs,
    failure,
    input.requestHeaders,
    responseHeaders,
    input.admission,
  );
  // 退避期间不持票：这次尝试到此结束，槽位让给别人。
  await input.admission.release();
  // Note: AI SDK can surface pre-output APICallError as an error chunk;
  // retry it here so protocol clients still receive the normal apiRetry status updates.
  try {
    await sleep(delayMs, input.input.request.abortSignal);
  } catch (sleepError) {
    const sleepFailure = classifyModelFailure(sleepError, input.input.request.abortSignal);
    // SSE error chunk 在 helper 内等待 retry；取消发生时 iterator 仍存在，
    // 外层仅按 iterator 判断会误记为 stream。先在真实等待边界写入 connect 事实。
    throw toAdapterError(sleepError, sleepFailure, statusContext, input.attempt, {
      errorPhase: "connect",
    });
  }
  return streamChunkResult({
    emittedError: true,
    retryScheduled: true,
    offPeakQueueHold: offPeak?.kind === "queued",
  });
}
