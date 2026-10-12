// Modified by ZCode Feiyu.
import type { SessionEvent, TargetChangedPayload } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import {
  ProjectionEventCommitWaitError,
  DETACHED_CHILD_PUBLISHER_GRACE_MS,
} from "./v4-gateway-conversation-v4-gateway-options.js";
import { ProjectionPayloadTooLargeError } from "./conversation-topic-publisher.js";
import type { ConversationV4Gateway } from "./v4-gateway.js";

export function ingestNormalizedEvent(
  this: ConversationV4Gateway,
  sessionId: string,
  event: SessionEvent,
): void {
  const publisher = this["ensurePublisher"](sessionId);
  const promotedQueueRemoval =
    event.type === SessionEventType.TurnSteerDiscarded &&
    (
      event.payload as {
        reason?: string;
      }
    ).reason === "promoted";
  const removedQueueItems =
    event.type === SessionEventType.TurnSteerDrained ||
    event.type === SessionEventType.TurnSteerDiscarded
      ? (
          (
            event.payload as {
              pendingInputIds?: string[];
            }
          ).pendingInputIds ?? []
        ).flatMap((queueItemId) => {
          const item = publisher
            .getSnapshot()
            .queue.items.find((candidate) => candidate.queueItemId === queueItemId);
          return item ? [item] : [];
        })
      : [];
  try {
    publisher.ingest(event);
  } catch (error) {
    const commitError =
      error instanceof ProjectionEventCommitWaitError
        ? error
        : new ProjectionEventCommitWaitError(
            "fault.projectionEventCommit.applyFailed",
            `projection failed to apply event ${String(event.id)}`,
            { cause: error },
          );
    this["rejectProjectionEventCommit"](sessionId, String(event.id), commitError);
    if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
    this["host"].onError?.("v4.projection.payloadTooLarge", error);
    if (!this["projectionFaultedSessions"].has(sessionId)) {
      this["projectionFaultedSessions"].add(sessionId);
      void Promise.resolve(
        this["host"].terminateTurnForProjectionFault?.(sessionId, error.reasonCode),
      ).catch((terminateError) => {
        this["host"].onError?.("v4.projection.terminate", terminateError);
      });
    }
    return;
  }
  this["resolveProjectionEventCommit"](sessionId, String(event.id));
  if (
    !this["hydrationBuffers"].has(sessionId) &&
    (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError)
  ) {
    try {
      this["host"].onHighspeedTurnTerminal?.(sessionId, event, publisher.getSnapshot());
    } catch (error) {
      this["host"].onError?.("v4.projection.highspeedMetrics", error);
    }
  }
  if (
    event.type === SessionEventType.TargetChanged &&
    (event.payload as TargetChangedPayload).target?.status === "complete"
  ) {
    try {
      this["host"].onTargetCompleted?.(sessionId, event);
    } catch (error) {
      this["host"].onError?.("v4.projection.targetCompleted", error);
    }
  }
  if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
    this["projectionFaultedSessions"].delete(sessionId);
  }
  if (event.type === SessionEventType.TurnSteerQueued) {
    const queueItemId = (
      event.payload as {
        pendingInputId?: string;
      }
    ).pendingInputId;
    const item = queueItemId
      ? publisher
          .getSnapshot()
          .queue.items.find((candidate) => candidate.queueItemId === queueItemId)
      : undefined;
    if (item) this["inbox"].pinLiveInput(sessionId, item);
  }
  if (!promotedQueueRemoval) {
    if (removedQueueItems.length > 0) {
      // delete/clear 已先把 durable session_input 写成 cancelled，但本 session
      // 的 persistent command index 可能缓存过旧空结果。必须先失效再解除 live pin，
      // 否则 LRU 淘汰后同 commandId 查询仍可能 unknown 并被重复执行。
      this["host"].invalidatePersistentCommandFacts?.(sessionId);
    }
    for (const item of removedQueueItems) {
      this["inbox"].releaseLiveInput(
        {
          sessionId,
          commandId: item.sourceCommandId,
        },
        event.type === SessionEventType.TurnSteerDiscarded
          ? {
              // 删除队列后不能把旧 accepted 放回 LRU；否则 query 在缓存淘汰前看不到取消终态。
              commandId: item.sourceCommandId,
              status: "failed",
              reasonCode: "fault.command.inputCancelled",
              revisionAtDecision: publisher.getSnapshot().revision,
            }
          : undefined,
      );
    }
  }
  if (event.type === SessionEventType.SessionInputPromoted) {
    const sourceCommandId = (
      event.payload as {
        sourceCommandId?: string;
      }
    ).sourceCommandId;
    if (sourceCommandId) {
      // persistent index 可能早于本条 user message 被 query 过；先失效再解 pin，
      // 后续 LRU 淘汰回源时才能重读刚提交的 transcript，而不是命中旧空 seed。
      this["host"].invalidatePersistentCommandFacts?.(sessionId);
      this["inbox"].releaseLiveInput({ sessionId, commandId: sourceCommandId });
    }
  }
  // assistant 守恒：投影拒收了正文流（订阅中途建 publisher、错过
  // TurnStarted 的典型形态）→ 撤销 hydrated 标记，下次订阅强制从持久事实重新
  // hydration 补齐缺段——静默丢会让内容缺失直到用户手动刷新才恢复。
  if (
    publisher.getDroppedContentStreamEventCount() > 0 &&
    this["hydratedSessions"].has(sessionId)
  ) {
    this["hydratedSessions"].delete(sessionId);
    this["host"].onError?.(
      "v4.assistantConservation",
      new Error(
        `projection dropped content stream events for session ${sessionId}; scheduling re-hydration`,
      ),
    );
  }
  for (const [routeKey, state] of this["flushStates"]) {
    if (state.sessionId !== sessionId) continue;
    this["scheduleFlush"](routeKey, state, publisher);
  }
  // sessions-index fan-out（防御式：任何异常都不能打断 conversation 主路径）。
  this["fanOutToIndex"](sessionId, event);
}

export function ingestDetachedLiveSession(
  this: ConversationV4Gateway,
  sessionId: string,
  event: SessionEvent,
  parentSessionId?: string,
): void {
  if (!this["detachedLiveSessions"].has(sessionId)) {
    this["host"].onDebug?.(`register detached live child publisher session=${sessionId}`);
  }
  this["detachedLiveSessions"].add(sessionId);
  if (parentSessionId && parentSessionId !== sessionId) {
    this["detachedChildParent"].set(sessionId, parentSessionId);
    let children = this["detachedChildrenByParent"].get(parentSessionId);
    if (!children) {
      children = new Set();
      this["detachedChildrenByParent"].set(parentSessionId, children);
    }
    children.add(sessionId);
  }
  // child 是一次性 session，没有 record 也没有后继 turn，publisher 曾驻留到进程退出。
  // 记下终态时间，供 pruneDetachedChildPublishers 在 grace 后释放；child 再次开 turn 则撤销。
  if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
    this["detachedTerminalAt"].set(sessionId, Date.now());
  } else if (event.type === SessionEventType.TurnStarted) {
    this["detachedTerminalAt"].delete(sessionId);
  }
  this.ingest(sessionId, event);
}

export function pruneDetachedChildPublishers(
  this: ConversationV4Gateway,
  nowMs: number = Date.now(),
  graceMs: number = DETACHED_CHILD_PUBLISHER_GRACE_MS,
): number {
  let released = 0;
  // 释放回调会修改登记表，保留本次 tick 的固定候选集合。
  for (const [childId, terminalAt] of Array.from(this["detachedTerminalAt"])) {
    if (nowMs - terminalAt < graceMs) continue;
    if (this["host"].sessionExists(childId)) continue;
    if (this["publishers"].get(childId)?.hasSubscribers()) continue;
    this["releaseDetachedChild"](childId);
    released += 1;
  }
  return released;
}

export function releaseDetachedChild(this: ConversationV4Gateway, childId: string): void {
  this["host"].onDebug?.(`release detached live child publisher session=${childId}`);
  this["cleanupSessionRuntime"](childId, { clearCommandInbox: false, notifyIndexRemoved: false });
}

export function fanOutToIndex(
  this: ConversationV4Gateway,
  sessionId: string,
  event: SessionEvent,
): void {
  if (event.type === SessionEventType.ModelStreaming) return;
  // 工作流进度同样是高频流（实测 8s 4000 条），但列表要继续动，所以不是丢弃而是
  // leading + trailing 窗口节流：窗内合并为窗末一帧，终态仍在一个窗口内送达。
  if (event.type === SessionEventType.DynamicWorkflowRunProgress) {
    this["indexFanoutThrottle"].request(sessionId);
    return;
  }
  this["publishCurrentSummaryToIndex"](sessionId);
}
