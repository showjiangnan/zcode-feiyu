// Modified by ZCode Feiyu.
import type {
  ConversationDelta,
  ToolCallRow,
  DeliveryProfile,
  ConversationTopicFrame,
  DeliveryProfileName,
  SubscribeAck,
} from "@zcode/shared/zcode-protocol-v4";
import { Buffer } from "node:buffer";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import {
  PROTOCOL_V4_LIMITS,
  coalesceConversationDeltas,
  utf8JsonByteLength,
} from "@zcode/shared/zcode-protocol-v4";

export interface LogEntry {
  seq: number;
  deltas: ConversationDelta[];
}

export const TERMINAL_PLAN_STATUSES: ReadonlySet<ToolCallRow["status"]> = new Set([
  "success",
  "error",
  "cancelled",
]);

/**
 * cold replay 会高频测量临时 delta；TextEncoder 会为每次测量再分配完整 Uint8Array。
 * CLI 已固定运行在 Node，这里对同一 JSON 文本直接计算精确 UTF-8 字节数，不做近似估算。
 */
export function coldHydrationJsonByteLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasPlanMarkdown(row: ToolCallRow): boolean {
  if (isRecord(row.input)) {
    const plan = row.input.plan;
    if (typeof plan === "string" && plan.trim().length > 0) return true;
  }
  if (!row.inputText.trim()) return false;
  try {
    const parsed: unknown = JSON.parse(row.inputText);
    return isRecord(parsed) && typeof parsed.plan === "string" && parsed.plan.trim().length > 0;
  } catch {
    return false;
  }
}

export interface Subscription {
  subscriptionId: string;
  connectionId: string;
  profile: DeliveryProfile;
  /**
   * 这条订阅认不认得 `workflowRun.*` 键级增量（握手能力位，由可信 host 注入）。
   * false = 旧消费者：增量折成整键 patch、快照裁到旧界（conversation-workflow-run-deltas.ts）。
   */
  workflowRunDeltas: boolean;
  /** flush buffer：push 时已过 profile 过滤与该订阅的编码，flush 时 coalesce 打帧。 */
  buffer: ConversationDelta[];
  bufferBytes: number;
  /** buffer 超限后只保留恢复意图，不继续为慢订阅者积压 delta。 */
  resyncRequired: boolean;
  /** 帧区间记账水位：下一帧 fromSeq（(fromSeq, toSeq] 语义）。 */
  sentSeq: number;
  /** 编码/写入期间保留的稳定 logical frame。 */
  inFlight: TopicFrameReservation<ConversationTopicFrame> | null;
  nextLogicalFrameOrdinal: number;
}

export interface ConversationSubscribeParams {
  connectionId: string;
  base?: { logEpoch: string; seq: number };
  /** 缺省 replayable（ws 默认；MessagePort 宿主显式传 continuous）。 */
  deliveryProfile?: DeliveryProfileName;
  /**
   * 该连接的 clientHello 声明过认得 `workflowRun.*` 增量。与 deliveryProfile 同族：可信 host
   * 注入，面向 UI 的 subscribe 选不了。缺省 false——能力位缺席一律按旧消费者办。
   */
  workflowRunDeltas?: boolean;
}

export interface ConversationSubscribeResult {
  ack: SubscribeAck;
  reservation: TopicFrameReservation<ConversationTopicFrame> | null;
  /** initial encode 失败且 ACK 未 admission 时，原子恢复被替换的旧 subscription。 */
  rollback(): boolean;
  /** snapshot 帧或 resume 的续传帧；resume 且无新增时为 null（客户端水位已对齐）。 */
  readonly frame: ConversationTopicFrame | null;
}

export interface ConversationResyncRequest {
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
}

export interface ConversationTopicPublisherOptions {
  /** CLI 时钟（frame.sentAt / clockOffset 估计源）。 */
  now?: () => number;
  /** 事件保留窗（条），默认 PROTOCOL_V4_LIMITS.eventRetentionPerSession。 */
  retention?: number;
  /** 每订阅者 coalesce 后 op 上限；主要用于协议配置与边界测试。 */
  subscriberBufferMaxOps?: number;
  /** 每订阅者 logical deltas payload 的 UTF-8 byte 上限。 */
  subscriberBufferMaxBytes?: number;
}

export interface ConversationSubscriberBufferLimits {
  maxOps?: number;
  /** 字节下限（默认 1MiB）；实际上限见 conversationSubscriberBufferByteLimit。 */
  maxBytes?: number;
  /** 当前 wire snapshot logical frame 的保守上界；缺省 0 = 只按下限裁决。 */
  snapshotBytesUpperBound?: number;
}

export class ProjectionPayloadTooLargeError extends Error {
  readonly reasonCode = "proto.payloadTooLarge";

  constructor(readonly logicalBytes: number) {
    super(
      `conversation projection exceeds ${PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes} bytes`,
    );
    this.name = "ProjectionPayloadTooLargeError";
  }
}

// 运行中正文必须给 TurnError/TurnComplete 的 bounded terminal patch 留出空间；否则正文
// 恰好占满 16MiB 后，停止 turn 的终态本身也无法进入可传输 snapshot。
export const PROJECTION_TERMINAL_RESERVE_BYTES = 64 * 1024;

// row.actions 的 schema 只有 4 个 true 布尔值和一个短枚举；含 JSON key/父级包装不足
// 128 bytes。批量 checkpoint 之间按 wire tail 的每行完整预留，保证延迟 materialize
// 不会让 payload 上界低估。
export const HYDRATION_ACTION_BYTES_PER_WIRE_ROW = 128;

export const HYDRATION_EVENT_WIRE_OVERHEAD_BYTES = 64;

// logical snapshot frame 中 sequence number 同时出现在 frame.toSeq 与 snapshot.seq。
export const HYDRATION_SEQUENCE_NUMBER_OCCURRENCES = 2;

export function hydrationSequenceNumberBytes(sequenceNumber: number): number {
  return String(sequenceNumber).length * HYDRATION_SEQUENCE_NUMBER_OCCURRENCES;
}

export type ConversationSubscriberBufferResult =
  | {
      kind: "buffered";
      deltas: ConversationDelta[];
      encodedBytes: number;
    }
  | { kind: "overflow" };

export function nonNegativeHardBound(
  value: number | undefined,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? maximum;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return Math.min(Math.floor(resolved), maximum);
}

/**
 * subscriber buffer 的实际字节上限 = min(max(下限, snapshot 上界), 16MiB - 64KiB)（05 §3）。
 * 修复原因：overflow 的意义是用更小的 snapshot 换掉积压 delta；旧实现固定 1MiB，单条大
 * delta（如 3MiB bash 输出的 tool row upsert）就会降级为 snapshot，而 snapshot 因同一行仍在
 * 尾部窗口只会更大，还让客户端整份替换、丢掉已分页的历史行，turn navigator 随即全量重新
 * 分页——长 session 中每轮循环一次。外层钳位给帧外壳留出 assembly 余量，deltas 帧仍 <=16MiB。
 */
export function conversationSubscriberBufferByteLimit(
  floorBytes: number,
  snapshotBytesUpperBound: number,
): number {
  return Math.min(
    Math.max(floorBytes, snapshotBytesUpperBound),
    PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES,
  );
}

/**
 * profile filter 后的 delta 进入此纯函数；先与现有 buffer 合并并 coalesce，
 * 再按 op/UTF-8 bytes 双限额裁决——限额必须真正执行，只存裸 delta[] 不裁决的话，
 * 慢订阅者会持续堆积并最终生成不可控的大帧。
 */
export function appendConversationSubscriberBuffer(
  current: readonly ConversationDelta[],
  incoming: readonly ConversationDelta[],
  limits: ConversationSubscriberBufferLimits = {},
): ConversationSubscriberBufferResult {
  const maxOps = nonNegativeHardBound(
    limits.maxOps,
    PROTOCOL_V4_LIMITS.subscriberBufferMaxOps,
    "maxOps",
  );
  const maxBytes = nonNegativeHardBound(
    limits.maxBytes,
    PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes,
    "maxBytes",
  );
  const byteLimit = conversationSubscriberBufferByteLimit(
    maxBytes,
    limits.snapshotBytesUpperBound ?? 0,
  );
  const deltas = coalesceConversationDeltas([...current, ...incoming]);
  if (deltas.length > maxOps) return { kind: "overflow" };
  const encodedBytes = utf8JsonByteLength({ kind: "deltas", deltas });
  if (encodedBytes > byteLimit) return { kind: "overflow" };
  return { kind: "buffered", deltas, encodedBytes };
}
