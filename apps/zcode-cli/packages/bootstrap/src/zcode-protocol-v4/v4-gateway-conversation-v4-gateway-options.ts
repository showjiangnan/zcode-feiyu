// Modified by ZCode Feiyu.
import type { SessionEvent, FileSystemErrorCode } from "@zcode/contracts";
import type {
  SubscribeAck,
  ConversationOpenTiming,
  RoutedTopicWireFrame,
  RoutedTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import {
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  readZCodeAttachmentFaultCode,
  ZCodeAttachmentFaultError,
  ZCODE_ATTACHMENT_FAULT_CODES,
} from "@zcode/shared/zcode-protocol-v4";
import { isFileSystemPortError } from "@zcode/contracts";

export interface ConversationV4GatewayOptions {
  now?: () => number;
  /** logEpoch 生成器（默认进程内随机；测试注入固定值保证确定性）。 */
  createLogEpoch?: (sessionId: string) => string;
}

export interface FlushState {
  sessionId: string;
  topic: string;
  subscriptionId: string;
  connectionId: string;
  deliveryProfile: "continuous" | "replayable";
  flushWindowMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface HydrationBuffer {
  cancelled: boolean;
  eventIds: Set<string>;
  rawEvents: SessionEvent[];
}

export interface RawSequenceState {
  /** 已经由 cold snapshot 或 live replay 消费的 runtime raw cursor。 */
  sourceEventSeq: number;
  /** transportSeq = rawSeq + offset；遇到 sequence=0 时会向前校正。 */
  offset: number;
  lastTransportSeq: number;
  seenEventIds: Set<string>;
  /** publisher 已成功 apply 的 event；runtime sink 已看见但仍在 gap buffer 的不在此集合。 */
  appliedEventIds: Set<string>;
  /** publisher apply 失败事实；临时 sink 迟到注册 waiter 时也必须立即 reject。 */
  failedEventById: Map<string, Error>;
  /** notify sink 可乱序；只有从 sourceEventSeq+1 连续时才可向投影 drain。 */
  pendingByRawSeq: Map<number, SessionEvent>;
  /** synthesized hydration 重建投影时，补回持久读取边界之后已经到达的 raw 事实。 */
  recentRawEventsById: Map<string, SessionEvent>;
}

export interface ProjectionEventCommitWaiter {
  resolve(): void;
  reject(error: Error): void;
}

export const PROJECTION_EVENT_COMMIT_TIMEOUT_MS = 25_000;

export const MAX_TELEMETRY_EVENT_IDS = 2_000;

/** detached subagent child 终态后无订阅者时，publisher 由低频 tick 释放前的保留时长。 */
export const DETACHED_CHILD_PUBLISHER_GRACE_MS = 120_000;

export class ProjectionEventCommitWaitError extends Error {
  constructor(
    readonly reasonCode:
      | "fault.projectionEventCommit.aborted"
      | "fault.projectionEventCommit.applyFailed"
      | "fault.projectionEventCommit.disposed"
      | "fault.projectionEventCommit.gatewayDisposed"
      | "fault.projectionEventCommit.rehydrated"
      | "fault.projectionEventCommit.timeout",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectionEventCommitWaitError";
  }
}

/**
 * server 内部分派结果：initial frame 只供 request-scoped post-response outbox
 * 消费，公共 JSON-RPC result schema 始终严格为 `{ ack }`。
 */
export interface V4SubscribeDispatchResult<TFrame> {
  ack: SubscribeAck & { openTiming?: ConversationOpenTiming };
  initialFrame: TFrame | null;
  initialWires: RoutedTopicWireFrame[];
  commit(): boolean;
}

export function encodeReservedTopicFrame(
  reservation: TopicFrameReservation<RoutedTopicFrame>,
): RoutedTopicWireFrame[] {
  return encodeTopicWireFrames(reservation.frame, {
    deliveryKind: reservation.deliveryKind,
    topic: reservation.frame.topic,
    subscriptionId: reservation.frame.subscriptionId,
    logicalFrameId: reservation.logicalFrameId,
    logicalFrameOrdinal: reservation.logicalFrameOrdinal,
    measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
  }) as RoutedTopicWireFrame[];
}

/** 所有 physical wire 都被下游接受后才 commit publisher 水位。 */
export function emitReservedTopicFrame<F extends RoutedTopicFrame>(
  reservation: TopicFrameReservation<F>,
  emit: (wire: RoutedTopicWireFrame) => unknown,
): boolean {
  const wires = encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>);
  for (const wire of wires) emit(wire);
  return reservation.commit();
}

export function subscriptionRouteKey(
  topic: string,
  subscriptionId: string,
  connectionId: string,
): string {
  return `${topic}\0${subscriptionId}\0${connectionId}`;
}

export function defaultLogEpoch(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function artifactRefBelongsToSession(ref: string, sessionId: string): boolean {
  return ref.startsWith(`zcode-artifact://${encodeURIComponent(sessionId)}/`);
}

/** 附件在文件系统层「确定不存在」的错误码集合。 */
export const MISSING_ATTACHMENT_FS_CODES = new Set<FileSystemErrorCode>([
  "not_found",
  "is_directory",
  "not_file",
]);

/**
 * 把 host / FileSystemPort 抛出的错误归一成带稳定码的附件 fault。
 * host 已经给出结构化 fault 码时原样透传，其余按 FileSystemPortError.code 判定；
 * 都不匹配则保持原错误，让上层按「未知」处理，而不是猜成确定分类。
 */
export function toShareStatFault(error: unknown): unknown {
  if (readZCodeAttachmentFaultCode(error)) return error;
  if (isFileSystemPortError(error) && MISSING_ATTACHMENT_FS_CODES.has(error.code)) {
    return new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotFound, {
      cause: error,
    });
  }
  return error;
}

export { V4CommandNoopError, V4CommandNotImplementedError } from "./v4-command-errors.js";
