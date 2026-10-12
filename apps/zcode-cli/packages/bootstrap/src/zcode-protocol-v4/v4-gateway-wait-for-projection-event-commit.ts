// Modified by ZCode Feiyu.
import {
  ProjectionEventCommitWaitError,
  PROJECTION_EVENT_COMMIT_TIMEOUT_MS,
} from "./v4-gateway-conversation-v4-gateway-options.js";
import type { ProjectionEventCommitWaiter } from "./v4-gateway-conversation-v4-gateway-options.js";
import { SessionEventType } from "@zcode/contracts";
import type { ConversationV4Gateway } from "./v4-gateway.js";

export function waitForProjectionEventCommit(
  this: ConversationV4Gateway,
  sessionId: string,
  eventId: string,
  options: {
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  if (this["disposed"]) {
    return Promise.reject(
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.gatewayDisposed",
        "conversation gateway is disposed",
      ),
    );
  }
  const state = this["getOrCreateRawSequenceState"](sessionId);
  if (state.appliedEventIds.has(eventId)) return Promise.resolve();
  const failed = state.failedEventById.get(eventId);
  if (failed) return Promise.reject(failed);
  if (options.signal?.aborted) {
    return Promise.reject(
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.aborted",
        `projection event commit wait aborted: ${eventId}`,
        { cause: options.signal.reason },
      ),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const byEvent = this["projectionEventCommitWaiters"].get(sessionId) ?? new Map();
    this["projectionEventCommitWaiters"].set(sessionId, byEvent);
    const waiters = byEvent.get(eventId) ?? new Set();
    byEvent.set(eventId, waiters);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      waiters.delete(waiter);
      if (waiters.size === 0) byEvent.delete(eventId);
      if (byEvent.size === 0) this["projectionEventCommitWaiters"].delete(sessionId);
    };
    const waiter: ProjectionEventCommitWaiter = {
      resolve: () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    };
    const onAbort = () => {
      // 只 reject 当前 waiter 会让 raw gap 中的 TurnStarted 继续存活；
      // command 已 cancelled 后补齐 gap，迟到事件仍会进入 canonical projection。
      // event failure 必须固化到 sequence state，后续 drain 只推进 cursor、不再 apply。
      this["rejectProjectionEventCommit"](
        sessionId,
        eventId,
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.aborted",
          `projection event commit wait aborted: ${eventId}`,
          { cause: options.signal?.reason },
        ),
      );
    };
    const timeout = setTimeout(() => {
      this["rejectProjectionEventCommit"](
        sessionId,
        eventId,
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.timeout",
          `projection event commit wait timed out: ${eventId}`,
        ),
      );
    }, PROJECTION_EVENT_COMMIT_TIMEOUT_MS);
    timeout.unref?.();
    waiters.add(waiter);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForPermissionGrantCommit(
  this: ConversationV4Gateway,
  sessionId: string,
  eventId: string,
): Promise<void> {
  const state = this["getOrCreateRawSequenceState"](sessionId);
  if (state.failedEventById.has(eventId)) {
    const event = state.recentRawEventsById.get(eventId);
    if (
      event?.type !== SessionEventType.SessionModeChanged ||
      !(
        event.payload as {
          permissionGrant?: unknown;
        }
      ).permissionGrant
    ) {
      throw new Error("Permission grant event unavailable for recovery");
    }
    await this["hydrationInFlight"].get(sessionId);
    this["hydratedSessions"].delete(sessionId);
    await this["hydratePublisher"](sessionId, undefined, true);
  }
  await this.waitForProjectionEventCommit(sessionId, eventId);
}
