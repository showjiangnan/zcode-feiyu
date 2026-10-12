// Modified by ZCode Feiyu.
import { canRetryEmptyCompletion, scheduleEmptyCompletionRetry } from "./empty-completion-retry.js";
import { classifyModelFailure } from "./failure-classifier.js";

import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";

import {
  createRequestVerificationEmptyStreamError,
  isRequestVerificationRejection,
} from "./request-security-edition/recovery.js";

import { recordStreamTextDebug } from "./runner-debug.js";
import {
  isSuspiciousStreamDiagnostics,
  isZeroOutputModelCompletion,
  logStreamDiagnostics,
} from "./runner-diagnostics.js";

import { TerminalStreamChunkError, toAdapterError } from "./runner-retry.js";

import type { AiSdkStreamTextResult } from "./runner-runtime.js";
import { publishModelStatus } from "./runner-status.js";
import { providerRequestIdFromHeaders } from "./runner-telemetry.js";

import { statusPublishOptions, resolveStreamResponseHeaders } from "./runner-stream-status.js";

import { compactStreamFailureContext } from "./runner-stream-failure-policy.js";

import type { StreamAttemptContext, StreamAttemptOutcome } from "./runner-stream-state.js";
export async function completeStreamAttempt(
  context: StreamAttemptContext,
  streamResult: AiSdkStreamTextResult,
): Promise<StreamAttemptOutcome> {
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
    admission,
    runState,
    state,
  } = context;
  if (!state.emittedError) {
    // 自然 EOF 后合成的业务错误会通过 TerminalStreamChunkError 直接离开外层 catch；
    // compact 上下文在普通主链路为空，因此必须在合成现场显式保留 stream 阶段。
    // 先识别 provider business error，再考虑 generic empty；否则额度等
    // HTTP 200 空流会被误判成可重试的暂时性空响应。
    const hiddenProviderBusinessError = detectProviderBusinessFinishError({
      providerId: String(state.statusContext.providerId),
      providerKind: state.statusContext.providerKind,
      source:
        diagnostics.lastFinishChunk ??
        ({
          type: "finish",
          finishReason: diagnostics.finishReason,
          rawFinishReason: diagnostics.rawFinishReason,
        } satisfies Record<string, unknown>),
    });
    if (hiddenProviderBusinessError) {
      if (isRequestVerificationRejection(hiddenProviderBusinessError))
        throw hiddenProviderBusinessError;
      const failure = classifyModelFailure(hiddenProviderBusinessError, input.request.abortSignal);
      throw new TerminalStreamChunkError(
        toAdapterError(hiddenProviderBusinessError, failure, state.statusContext, attempt, {
          ...compactStreamFailureContext(
            input.request.preserveProviderStreamBoundaries,
            "response_body",
          ),
          errorPhase: "stream",
        }),
      );
    }

    if (isSuspiciousStreamDiagnostics(diagnostics)) {
      // 403 JSON 等业务错误有时不会让 AI SDK 抛出 error chunk，流会以空 completion 结束；
      // 若不在 adapter 层终止，core 会误报 “Model returned no text...”。
      const streamEndedWithoutOutputError =
        detectProviderBusinessFinishError({
          providerId: String(state.statusContext.providerId),
          providerKind: state.statusContext.providerKind,
          source: diagnostics.lastErrorChunk ?? diagnostics.lastFinishChunk,
        }) ??
        createRequestVerificationEmptyStreamError({
          accountMode: state.resolved.accountAccess?.mode,
          headers: state.resolved.headers,
          providerId: String(state.statusContext.providerId),
          providerKind: state.resolved.providerKind,
        });
      if (streamEndedWithoutOutputError) {
        if (isRequestVerificationRejection(streamEndedWithoutOutputError))
          throw streamEndedWithoutOutputError;
        const failure = classifyModelFailure(
          streamEndedWithoutOutputError,
          input.request.abortSignal,
        );
        throw new TerminalStreamChunkError(
          toAdapterError(streamEndedWithoutOutputError, failure, state.statusContext, attempt, {
            ...compactStreamFailureContext(
              input.request.preserveProviderStreamBoundaries,
              "response_body",
            ),
            errorPhase: "stream",
          }),
        );
      }

      if (
        input.request.preserveProviderStreamBoundaries !== true &&
        isZeroOutputModelCompletion({
          finishReason: diagnostics.finishReason,
          reasoningLength: diagnostics.reasoningDeltaChars,
          textLength: diagnostics.textDeltaChars,
          toolCallCount: diagnostics.toolCallCount,
          usage: diagnostics.usage,
        }) &&
        canRetryEmptyCompletion({
          abortSignal: input.request.abortSignal,
          attempt,
          maxAttempts: input.retry.maxAttempts,
          retryCount: runState.emptyCompletionRetryCount,
        })
      ) {
        const responseHeaders = await resolveStreamResponseHeaders(streamResult);
        const completedAt = Date.now();
        // finish 会把 retry-safe 前奏刷成可见事件；空 completion 需在
        // flush 前进入一次 adapter retry，避免 core 把第一次 attempt 当成已完成。
        logStreamDiagnostics({
          attempt,
          diagnostics,
          durationMs: completedAt - startedAt,
          emittedError: state.emittedError,
          emittedEvent: state.emittedEvent,
          logger: input.logger,
          outboundHeaders: state.resolved.headers,
          statusContext: state.statusContext,
        });
        // 空流也可能报告输入消费；原路径只 retry 会把这次 usage 丢掉。
        await publishModelStatus(
          {
            ...state.statusContext,
            attempt,
            durationMs: completedAt - startedAt,
            finishReason: diagnostics.finishReason,
            usage: diagnostics.usage,
            timestamp: new Date(completedAt).toISOString(),
            type: "model_request_completed",
          },
          statusPublishOptions(input, admission),
        );
        state.terminalStatusPublished = true;
        await admission.release();
        runState.emptyCompletionRetryCount += 1;
        await scheduleEmptyCompletionRetry({
          abortSignal: input.request.abortSignal,
          attempt,
          completedAt,
          errorPhase: "stream",
          logger: input.logger,
          requestHeaders: state.requestHeaders,
          requestStatusSink: input.request.statusSink,
          responseHeaders,
          retry: input.retry,
          retryBudgetAttempt,
          startedAt,
          statusContext: state.statusContext,
          statusSink: input.statusSink,
          streamOutputCommitted: false,
        });
        return "retry";
      }
    }
  }

  logStreamDiagnostics({
    attempt,
    diagnostics,
    durationMs: Date.now() - startedAt,
    emittedError: state.emittedError,
    emittedEvent: state.emittedEvent,
    logger: input.logger,
    outboundHeaders: state.resolved.headers,
    statusContext: state.statusContext,
  });
  if (!state.emittedError) {
    const completedAt = Date.now();
    const responseHeaders = await resolveStreamResponseHeaders(streamResult);
    await publishModelStatus(
      {
        ...state.statusContext,
        attempt,
        durationMs: completedAt - startedAt,
        requestHeaderCount: state.requestHeaderCount,
        requestHeaders: state.requestHeaders,
        responseHeaderCount: Object.keys(responseHeaders).length,
        responseHeaders,
        providerRequestId: providerRequestIdFromHeaders(responseHeaders),
        finishReason: diagnostics.finishReason,
        usage: diagnostics.usage,
        timeToFirstProviderEventMs: state.timeToFirstProviderEventMs,
        timeToFirstContentMs: state.timeToFirstContentMs,
        timeToFirstTextMs: state.timeToFirstTextMs,
        streamMaxIdleMs: state.streamMaxIdleMs || undefined,
        streamStallCount: state.streamStallCount,
        streamOutputCommitted: state.streamOutputCommitted,
        timestamp: new Date(completedAt).toISOString(),
        type: "model_request_completed",
      },
      statusPublishOptions(input, admission),
    );
    state.terminalStatusPublished = true;
  }
  if (recordModelIO && state.options) {
    await recordStreamTextDebug({
      modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
      attempt,
      debugDir: input.debugDir,
      isDev,
      normalizedToolCalls: toolCallAssembler.snapshotNormalizedToolCalls(),
      options: state.options,
      recordModelIO,
      request: attemptRequest,
      requestId: state.statusContext.requestId,
      resolved: state.resolved,
      result: streamResult,
      startedAt,
    });
  }
  return "completed";
}
