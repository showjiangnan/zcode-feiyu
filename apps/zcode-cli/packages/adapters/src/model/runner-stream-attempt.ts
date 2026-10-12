// Modified by ZCode Feiyu.
import type { ModelStreamEvent } from "@zcode/contracts";

import {
  observeVisibleStreamEvent,
  applyStreamEventsToRetryBoundary,
} from "./runner-stream-boundary.js";

import type { StreamAttemptContext, StreamAttemptOutcome } from "./runner-stream-state.js";
import { readStreamAttemptEvents } from "./runner-stream-reader.js";
import { completeStreamAttempt } from "./runner-stream-completion.js";
export async function* runStreamAttempt(
  context: StreamAttemptContext,
): AsyncGenerator<ModelStreamEvent, StreamAttemptOutcome> {
  const {
    input,
    startedAt,
    pendingRetrySafeEvents,
    toolCallAssembler,
    publishVisibleMilestones,
    state,
  } = context;
  const streamResult = yield* readStreamAttemptEvents(context);

  if (state.retryScheduledFromStreamChunk) {
    if (state.offPeakQueueHoldFromStreamChunk) {
      // 排队等待不消耗重试预算：回退计数让 for 自增后原地重试。
      return "hold_retry_budget";
    }
    return "retry";
  }

  const flushedEvents = applyStreamEventsToRetryBoundary({
    emittedRetryBoundaryEvent: state.emittedRetryBoundaryEvent,
    events: toolCallAssembler.flush(),
    pendingRetrySafeEvents,
    preserveProviderStreamBoundaries: input.request.preserveProviderStreamBoundaries,
  });
  state.emittedEvent = state.emittedEvent || flushedEvents.emittedEvent;
  state.emittedRetryBoundaryEvent =
    state.emittedRetryBoundaryEvent || flushedEvents.emittedRetryBoundaryEvent;
  if (flushedEvents.visibleEvents.length > 0) {
    for (const visibleEvent of flushedEvents.visibleEvents) {
      const observation = observeVisibleStreamEvent(visibleEvent, Date.now() - startedAt);
      await publishVisibleMilestones(observation);
      state.streamOutputCommitted = state.streamOutputCommitted || observation.outputCommitted;
      yield visibleEvent;
    }
  }

  for (const pendingEvent of pendingRetrySafeEvents.splice(0)) {
    state.emittedEvent = true;
    const observation = observeVisibleStreamEvent(pendingEvent, Date.now() - startedAt);
    await publishVisibleMilestones(observation);
    state.streamOutputCommitted = state.streamOutputCommitted || observation.outputCommitted;
    yield pendingEvent;
  }

  return await completeStreamAttempt(context, streamResult);
}
