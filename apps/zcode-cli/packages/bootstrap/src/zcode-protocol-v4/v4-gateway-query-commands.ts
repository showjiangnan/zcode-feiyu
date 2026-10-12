// Modified by ZCode Feiyu.
import type {
  CommandsQueryResult,
  CommandAck,
  QueueItem,
  ConversationRowTarget,
} from "@zcode/shared/zcode-protocol-v4";
import {
  localTtftNow,
  commandsQueryParamsSchema,
  commandsQueryResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { observeCommandExecution } from "./command-execution-observation.js";
import type { ConversationRowTargetAction } from "./product-projection.js";
import type { ConversationV4Gateway } from "./v4-gateway.js";

export async function queryCommands(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<CommandsQueryResult> {
  const receivedAt = localTtftNow();
  const params = commandsQueryParamsSchema.parse(rawParams);
  // 校准是纯时钟探测，不能触发命令账本查询、恢复或 admission gate。
  if (params.clock)
    return {
      results: params.commands.map((key) => ({ key, result: "unknown" as const })),
      clock: { instanceId: this["localTtft"].instanceId, receivedAt, sentAt: localTtftNow() },
    };
  await Promise.all(
    params.commands.map((key) => {
      const ready = key.sessionId === null ? undefined : this["readyFlights"].get(key.sessionId);
      return ready;
    }),
  );
  const results = await this["inbox"].query(params.commands);
  if (!params.includeExecution) return commandsQueryResultSchema.parse({ results });
  return commandsQueryResultSchema.parse({
    results: results.map((item) => {
      const publisher = item.key.sessionId ? this["publishers"].get(item.key.sessionId) : undefined;
      if (!publisher) return item;
      const snapshot = publisher.getSnapshot();
      return {
        ...item,
        execution: observeCommandExecution(
          item.key.commandId,
          item.result,
          snapshot,
          snapshot.rows.window,
        ),
      };
    }),
  });
}

export async function reconcileFailedInput(
  this: ConversationV4Gateway,
  sessionId: string,
  ack: CommandAck,
): Promise<void> {
  // 后台完成可能快于 admission ACK；先过同一 command gate，再更新缓存，避免 accepted 反向覆盖。
  await this["inbox"].query([{ sessionId, commandId: ack.commandId }]);
  this["inbox"].releaseLiveInput({ sessionId, commandId: ack.commandId }, ack);
}

export function getQueueItem(
  this: ConversationV4Gateway,
  sessionId: string,
  queueItemId: string,
): QueueItem | null {
  const snapshot = this["publishers"].get(sessionId)?.getSnapshot();
  const item = snapshot?.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
  return item ?? null;
}

export function hasQueueItemKind(
  this: ConversationV4Gateway,
  sessionId: string,
  kind: QueueItem["kind"],
): boolean {
  return Boolean(
    this["publishers"]
      .get(sessionId)
      ?.getSnapshot()
      .queue.items.some((candidate) => candidate.kind === kind),
  );
}

export function hasQueuedDelivery(
  this: ConversationV4Gateway,
  sessionId: string,
  delivery: "guide" | "queue",
): boolean {
  return Boolean(
    this["publishers"]
      .get(sessionId)
      ?.getSnapshot()
      .queue.items.some((candidate) => candidate.delivery.admitted === delivery),
  );
}

export function getQueueLength(this: ConversationV4Gateway, sessionId: string): number {
  return this["publishers"].get(sessionId)?.getSnapshot().queue.items.length ?? 0;
}

export function hasResidencyBlockingCommands(
  this: ConversationV4Gateway,
  sessionId: string,
): boolean {
  return this.getQueueLength(sessionId) > 0 || this["inbox"].hasPinnedSessionState(sessionId);
}

export function getQueueHead(
  this: ConversationV4Gateway,
  sessionId: string,
): {
  autoDrain: boolean;
  dispatchState: QueueItem["dispatch"]["state"];
  kind: QueueItem["kind"];
  queueItemId: string;
  text: string;
} | null {
  const snapshot = this["publishers"].get(sessionId)?.getSnapshot();
  const item = snapshot?.queue.items[0];
  if (!snapshot || !item) return null;
  return {
    autoDrain: snapshot.queue.autoDrain,
    dispatchState: item.dispatch.state,
    kind: item.kind,
    queueItemId: item.queueItemId,
    text: item.text,
  };
}

export function getInputRoutingMode(
  this: ConversationV4Gateway,
  sessionId: string,
): "startNow" | "enqueue" | "guide" | "reject" | "choice" | null {
  return this["publishers"].get(sessionId)?.getSnapshot().inputRouting.mode ?? null;
}

export function getSessionFollowupMode(
  this: ConversationV4Gateway,
  sessionId: string,
): "queue" | "guide" | null {
  return this["publishers"].get(sessionId)?.getSnapshot().config.followupMode ?? null;
}

export function getMessageIdForRow(
  this: ConversationV4Gateway,
  sessionId: string,
  rowId: number,
): string | null {
  return this["publishers"].get(sessionId)?.getMessageIdForRow(rowId) ?? null;
}

export function resolveRowActionTarget(
  this: ConversationV4Gateway,
  sessionId: string,
  target: ConversationRowTarget,
  action: ConversationRowTargetAction,
): ConversationRowTargetResolution | null {
  return this["publishers"].get(sessionId)?.resolveRowActionTarget(target, action) ?? null;
}

export function getMessageIdsForTurnRow(
  this: ConversationV4Gateway,
  sessionId: string,
  rowId: number,
): string[] {
  return this["publishers"].get(sessionId)?.getMessageIdsForTurnRow(rowId) ?? [];
}

export function isLatestAssistantSegmentRow(
  this: ConversationV4Gateway,
  sessionId: string,
  rowId: number,
): boolean | null {
  return this["publishers"].get(sessionId)?.isLatestAssistantSegmentRow(rowId) ?? null;
}

export function resolveStableForkCandidate(
  this: ConversationV4Gateway,
  sessionId: string,
  rowId: number,
): StableForkCandidateResolution | null {
  return this["publishers"].get(sessionId)?.resolveStableForkCandidate(rowId) ?? null;
}

export function isLatestRetryAssistantRow(
  this: ConversationV4Gateway,
  sessionId: string,
  rowId: number,
): boolean | null {
  return this["publishers"].get(sessionId)?.isLatestRetryAssistantRow(rowId) ?? null;
}

export function isLatestEditableUserRow(
  this: ConversationV4Gateway,
  sessionId: string,
  rowId: number,
): boolean | null {
  return this["publishers"].get(sessionId)?.isLatestEditableUserRow(rowId) ?? null;
}

export function getTurnIdForRow(
  this: ConversationV4Gateway,
  sessionId: string,
  rowId: number,
): string | null {
  return this["publishers"].get(sessionId)?.getTurnIdForRow(rowId) ?? null;
}

export function getTurnRewindAnchor(
  this: ConversationV4Gateway,
  sessionId: string,
  rowId: number,
): string | null {
  return this["publishers"].get(sessionId)?.getTurnRewindAnchor(rowId) ?? null;
}

export function disposeSession(this: ConversationV4Gateway, sessionId: string): void {
  this["cleanupSessionRuntime"](sessionId, {
    clearCommandInbox: false,
    notifyIndexRemoved: true,
  });
}

export function deactivateSession(this: ConversationV4Gateway, sessionId: string): void {
  this["cleanupSessionRuntime"](sessionId, {
    clearCommandInbox: true,
    notifyIndexRemoved: false,
  });
}

export function assertSessionRuntimeDeactivatable(
  this: ConversationV4Gateway,
  sessionId: string,
): void {
  if (!this["inbox"].hasPinnedSessionState(sessionId)) return;
  throw new Error(`Session command inbox is still pinned: ${sessionId}`);
}

export function hasConversationSubscribers(
  this: ConversationV4Gateway,
  sessionId: string,
): boolean {
  return this["publishers"].get(sessionId)?.hasSubscribers() ?? false;
}

export function collectMemoryDiagnostics(this: ConversationV4Gateway): Record<string, number> {
  return {
    publishers: this["publishers"].size,
    detachedLive: this["detachedLiveSessions"].size,
    detachedTerminal: this["detachedTerminalAt"].size,
    rawSeqStates: this["rawSequenceStates"].size,
  };
}
import type {
  ConversationRowTargetResolution,
  StableForkCandidateResolution,
} from "./product-projection.js";
