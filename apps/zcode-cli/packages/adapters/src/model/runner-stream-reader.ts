// Modified by ZCode Feiyu.
import type { ModelStreamEvent } from "@zcode/contracts";

import { resolveAnthropicRequestMetadataUserId } from "./anthropic-request-metadata.js";
import { canRetryEmptyCompletion } from "./empty-completion-retry.js";

import { isZeroOutputModelCompletion } from "./runner-diagnostics.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";

import { createStreamTextOptions } from "./runner-options.js";

import { resolveModelForAttempt } from "./runner-runtime-headers.js";
import type { AiSdkStreamTextResult } from "./runner-runtime.js";
import { publishModelStatus, publishModelTelemetryMilestone } from "./runner-status.js";

import { readNextWithStreamIdleTimeout } from "./stream-idle-timeout.js";

import { statusPublishOptions } from "./runner-stream-status.js";
import { handleStreamChunk } from "./runner-stream-chunks.js";
import {
  compactDirectToolCallCommitEvent,
  observeVisibleStreamEvent,
} from "./runner-stream-boundary.js";

import type { StreamAttemptContext } from "./runner-stream-state.js";
export async function* readStreamAttemptEvents(
  context: StreamAttemptContext,
): AsyncGenerator<ModelStreamEvent, AiSdkStreamTextResult> {
  const {
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
    authRetry,
    repairThinkingSignatureRejection,
    publishVisibleMilestones,
    admission,
    runState,
    state,
  } = context;

  state.resolved = await resolveModelForAttempt({
    attempt,
    reason: authRetry.takeReason(),
    request: authRetry.prepareRequest(attemptRequest),
    resolveModel: input.resolveModel,
  });
  const anthropicMetadataUserId = await resolveAnthropicRequestMetadataUserId({
    env: input.env,
    providerKind: state.resolved.providerKind,
    sessionId: state.statusContext.sessionId,
  });
  state.options = createStreamTextOptions({
    anthropicMetadataUserId,
    env: input.env,
    includeModelIO: recordModelIO,
    request: attemptRequest,
    resolved: state.resolved,
    statusContext: state.statusContext,
  });
  state.requestHeaders = sanitizeModelNetworkHeaders(state.options.headers);
  state.requestHeaderCount = Object.keys(state.requestHeaders).length;
  await publishModelStatus(
    {
      ...state.statusContext,
      attempt,
      requestHeaderCount: state.requestHeaderCount,
      requestHeaders: state.requestHeaders,
      timestamp: new Date(startedAt).toISOString(),
      type: "model_request_started",
    },
    statusPublishOptions(input, admission),
  );
  const streamResult = input.runtime.streamText(state.options);
  state.result = streamResult;
  state.streamIterator = streamResult.fullStream[Symbol.asyncIterator]();

  while (true) {
    const next = await readNextWithStreamIdleTimeout(state.streamIterator, {
      abortController: attemptAbortController.controller,
      onTimeout: async (error) => {
        state.streamStallCount += 1;
        state.streamMaxIdleMs = Math.max(state.streamMaxIdleMs, error.idleMs);
        await publishModelStatus(
          {
            ...state.statusContext,
            attempt,
            idleMs: error.idleMs,
            message: error.message,
            requestHeaderCount: state.requestHeaderCount,
            requestHeaders: state.requestHeaders,
            timeoutMs: error.timeoutMs,
            timestamp: new Date().toISOString(),
            type: "model_stream_stalled",
          },
          statusPublishOptions(input, admission),
        );
      },
      timeoutMs: streamIdleTimeoutMs,
    });
    if (next.done) {
      state.streamReachedNaturalEnd = true;
      break;
    }
    if (state.timeToFirstProviderEventMs === undefined) {
      state.timeToFirstProviderEventMs = Date.now() - startedAt;
      await publishModelTelemetryMilestone(
        {
          ...state.statusContext,
          attempt,
          elapsedMs: state.timeToFirstProviderEventMs,
          timestamp: new Date(startedAt + state.timeToFirstProviderEventMs).toISOString(),
          type: "model_first_provider_event",
        },
        { logger: input.logger, statusSink: input.statusSink },
      );
    }

    let event: Awaited<ReturnType<typeof handleStreamChunk>>;
    try {
      event = await handleStreamChunk({
        admission,
        attempt,
        chunk: next.value,
        diagnostics,
        emittedRetryBoundaryEvent: state.emittedRetryBoundaryEvent,
        input,
        pendingRetrySafeEvents,
        requestHeaderCount: state.requestHeaderCount,
        requestHeaders: state.requestHeaders,
        repairThinkingSignatureRejection,
        canRecoverProjectToken: (error) => authRetry.canRecoverProjectToken(error),
        retryBudgetAttempt,
        startedAt,
        statusContext: state.statusContext,
        toolCallAssembler,
      });
    } catch (error) {
      const directToolCommit = compactDirectToolCallCommitEvent(input.request, next.value);
      if (directToolCommit) {
        // 完整 direct tool-call 已是 provider 事件；name/input 校验即使抛错，
        // 也不能让 adapter 当作首事件前失败再次 SSE 重放。
        state.emittedRetryBoundaryEvent = true;
        for (const pendingEvent of pendingRetrySafeEvents.splice(0)) {
          state.emittedEvent = true;
          yield pendingEvent;
        }
        // 无 raw message-block provenance 的 provider 可能直接给完整 tool-call。
        // 先把 inferred block stop 交给隐藏 collector，再传播校验错误，避免 HTTP 重放。
        state.emittedEvent = true;
        yield directToolCommit;
      }
      throw error;
    }
    const shouldHoldEmptyCompletionEvents =
      !event.emittedError &&
      event.visibleEvents.some((visibleEvent) => visibleEvent.type === "finish") &&
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
      });
    if (shouldHoldEmptyCompletionEvents) {
      // finish 会把已缓存的 start 一并刷给 core；先暂存到自然 EOF，确认这是
      // generic empty 后再重试，避免第一次 attempt 的 finish/start 泄漏到 UI。
      event.visibleEvents.length = 0;
    }
    state.emittedError = state.emittedError || event.emittedError;
    state.emittedEvent = state.emittedEvent || event.emittedEvent;
    state.emittedRetryBoundaryEvent =
      state.emittedRetryBoundaryEvent || event.emittedRetryBoundaryEvent;

    if (event.retryScheduled) {
      // SSE error chunk 的 retry 是正常控制流，不会进入 catch；
      // 若不显式标记失败，finally 会跳过旧 attempt 的 iterator/tee 清理。
      // 下一次物理请求必须等待本轮 abort 与有界清理后才能启动。
      state.attemptFailed = true;
      state.awaitIteratorClose = true;
      state.retryScheduledFromStreamChunk = true;
      state.offPeakQueueHoldFromStreamChunk = event.offPeakQueueHold;
      break;
    }
    if (event.terminalError) {
      throw event.terminalError;
    }
    if (event.visibleEvents.length > 0) {
      for (const visibleEvent of event.visibleEvents) {
        const observation = observeVisibleStreamEvent(visibleEvent, Date.now() - startedAt);
        await publishVisibleMilestones(observation);
        state.streamOutputCommitted = state.streamOutputCommitted || observation.outputCommitted;
        yield visibleEvent;
      }
    }
  }
  return streamResult;
}
