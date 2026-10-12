// Modified by ZCode Feiyu.
// 状态仍由原 owner 独占；按事件职责装配 prototype 方法，确保原子 clone 继承同一实现。
import { ProductProjection } from "./product-projection.js";
import type {
  LogEntry,
  Subscription,
  ConversationTopicPublisherOptions,
} from "./conversation-topic-publisher-log-entry.js";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import {
  nonNegativeHardBound,
  ProjectionPayloadTooLargeError,
} from "./conversation-topic-publisher-log-entry.js";
import type { SessionEvent } from "@zcode/contracts";
import { installV4OwnerMethods } from "./owner-methods.js";
import * as part1 from "./conversation-topic-publisher-get-snapshot.js";
import * as part2 from "./conversation-topic-publisher-is-latest-retry-assistant-row.js";
import * as part3 from "./conversation-topic-publisher-subscribe-reserved.js";
import * as part4 from "./conversation-topic-publisher-resync-reserved.js";
import * as part5 from "./conversation-topic-publisher-ack-for.js";

export class ConversationTopicPublisher {
  readonly topic: string;

  private projection: ProductProjection;

  private readonly now: () => number;

  private readonly retention: number;

  private readonly subscriberBufferMaxOps: number;

  private readonly subscriberBufferMaxBytes: number;

  /** 有界日志：seq 升序；resume 只在 (floorSeq, currentSeq] 内合法。 */
  private readonly log: LogEntry[] = [];

  /** 保留窗下界：base.seq < floorSeq 的恢复请求已无法无损续传 → 只能 snapshot。 */
  private floorSeq = 0;

  private readonly subscriptions = new Map<string, Subscription>();

  private readonly subscriptionIdByConnection = new Map<string, string>();

  private nextSubscriptionSerial = 1;

  private nextLogicalFrameSerial = 1;

  /** 当前 snapshot logical frame 的保守上界；流式追加只累计增量，逼近上限才精确序列化。 */
  private wireSnapshotBytesUpperBound: number;

  constructor(
    private readonly sessionId: string,
    private readonly logEpoch: string,
    options: ConversationTopicPublisherOptions = {},
  ) {
    this.topic = `conversation/${sessionId}`;
    this.projection = new ProductProjection(sessionId, logEpoch);
    this.now = options.now ?? Date.now;
    this.retention = options.retention ?? PROTOCOL_V4_LIMITS.eventRetentionPerSession;
    this.subscriberBufferMaxOps = nonNegativeHardBound(
      options.subscriberBufferMaxOps,
      PROTOCOL_V4_LIMITS.subscriberBufferMaxOps,
      "subscriberBufferMaxOps",
    );
    this.subscriberBufferMaxBytes = nonNegativeHardBound(
      options.subscriberBufferMaxBytes,
      PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes,
      "subscriberBufferMaxBytes",
    );
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  declare getSnapshot: typeof part1.getSnapshot;

  /** 测试/闸门共用的 logical TopicFrame 字节口径（不是裸 snapshot 大小）。 */
  declare getWireSnapshotLogicalBytes: typeof part1.getWireSnapshotLogicalBytes;

  declare resolveStableForkCandidate: typeof part1.resolveStableForkCandidate;

  /** config 种子注入：直改投影初值，不产 delta / 不进事件日志。语义见 ProductProjection.seedConfig。 */
  declare seedConfig: typeof part1.seedConfig;

  /** 分享导入提示是静态只读元数据，不进入 delta/revision；可在 hydration 后幂等补种。 */
  declare seedSharedContextImport: typeof part1.seedSharedContextImport;

  /** usage 种子注入：冷恢复用持久化 token 水位覆盖 transcript 合成的 0 占位。 */
  declare seedUsage: typeof part1.seedUsage;

  /** cold hydration 的 store-verified subagent manifest，不产 delta。 */
  declare seedSubagents: typeof part1.seedSubagents;

  /**
   * 下发用快照：rows 只带尾部窗口（snapshotTailWindowRows），
   * totalCount/firstRowId 保留全序口径——客户端以 `window[0].rowId === firstRowId`
   * 判定已到顶，更早历史经 rows/range 游标拉取。投影内部快照保持全量
   * （rows/range 数据源 + findRow/messageId 锚点都依赖它），只在打帧边界截断。
   */
  declare private getWireSnapshot: typeof part1.getWireSnapshot;

  declare private getWireSnapshotForProfile: typeof part1.getWireSnapshotForProfile;

  /**
   * 一个订阅者的快照帧：profile 决定行可见性，能力位决定 `workflowRuns` 发全量还是旧界。
   *
   * 快照与增量必须同一档：一个收着旧界整键 patch 的客户端，如果快照里突然来了 512 个节点，
   * 它的 `.max(256)` 会让**整帧**解析失败（已知键上的解析错误不会只剥掉一个键）。
   */
  declare private getWireSnapshotForSubscription: typeof part1.getWireSnapshotForSubscription;

  /**
   * 一批 delta 的**每订阅者**编码：profile 过滤 + 旧消费者的整键折叠。
   *
   * 折叠取的是**当前**投影状态，所以恢复回放上历史增量会折成终态——中间态被跳过，终态一致，
   * 与 coalesce 的既有行为同规（conversation-workflow-run-deltas.ts 的文件头）。
   */
  declare private encodeDeltasForSubscription: typeof part1.encodeDeltasForSubscription;

  /**
   * 输入 admission 的候选 projection：用完整 QueueItem 表达同一份 intent，覆盖文本与附件引用。
   * QueueItem 元数据不小于立即启动后的 user row，因此通过此闸门的输入不会在后续首次
   * snapshot 才变成不可传输。此方法只读，不写 admission / event log。
   */
  declare measureInputAdmissionProjectionBytes: typeof part1.measureInputAdmissionProjectionBytes;

  declare private measureWireSnapshotBytes: typeof part1.measureWireSnapshotBytes;

  /**
   * rows/range（游标制）：取 rowId < beforeRowId 的最后 limit 行
   * （rowId 升序返回）。数据源 = 投影全量行（事件重放/transcript hydration 已灌入），
   * 与订阅流出自同一归约，天然满足「与全量重放前缀逐字节一致」。
   * 只读、无状态、超时重发安全；atLogEpoch 供客户端陈旧读整体丢弃。
   */
  declare getRowsRange: typeof part1.getRowsRange;

  /**
   * 返回当前有效分支里的完整终态计划目录。
   * wire snapshot 只保留 tail window；renderer 扫描可见 rows 会漏掉早期计划，
   * edit/retry 后还可能保留已经被权威 projection 裁掉的旧目录项。
   */
  declare getPlans: typeof part1.getPlans;

  /** rowId → 权威 messageId（forkAssistant/editUserQuery 桥接翻译）。 */
  declare getMessageIdForRow: typeof part1.getMessageIdForRow;

  declare resolveRowActionTarget: typeof part1.resolveRowActionTarget;

  /** rowId → 同一 product turn 内所有 transcript messageId。 */
  declare getMessageIdsForTurnRow: typeof part1.getMessageIdsForTurnRow;

  /** fork 目标必须是所属轮最后一段 assistantText。 */
  declare isLatestAssistantSegmentRow: typeof part1.isLatestAssistantSegmentRow;

  /** latestAssistantRetryOnly：retry 目标必须是全时间线最新且有 realUser cause 的 assistantText。 */
  declare isLatestRetryAssistantRow: typeof part2.isLatestRetryAssistantRow;

  /** latestQueryEditOnly：只有最后一轮 realUser userInput row 可 edit。 */
  declare isLatestEditableUserRow: typeof part2.isLatestEditableUserRow;

  /** rowId → product turnId（editUserQuery 无 assistant anchor 时回查 user messageId）。 */
  declare getTurnIdForRow: typeof part2.getTurnIdForRow;

  /** assistant 守恒：被拒收的正文流事件数（>0 = 投影可能缺段）。 */
  declare getDroppedContentStreamEventCount: typeof part2.getDroppedContentStreamEventCount;

  /** rowId → 其 turn 的 rewind 锚点 messageId（editUserQuery user 行定位）。 */
  declare getTurnRewindAnchor: typeof part2.getTurnRewindAnchor;

  private get currentSeq(): number {
    return this.projection.getSnapshot().seq;
  }

  /** 应用权威事件：投影推进 + 日志记账 + 扇出到各订阅者 flush buffer。 */
  declare ingest: typeof part2.ingest;

  /**
   * 在现有 publisher 内重物化 projection，保留 connection-owned subscriptions。
   *
   * gateway 过去 delete publisher 后新建实例，projection 虽恢复了，旧实例
   * 的 subscription registry / ownership / in-flight reservation 却一起丢失。重物化属于
   * 同一 topic authority 的状态替换，只应让既有订阅 resync，不应换 publisher 身份。
   */
  rehydrate(
    events: readonly SessionEvent[],
    options: { onPayloadTooLarge?: (error: ProjectionPayloadTooLargeError) => void } = {},
  ): void {
    // 重放不能先清空当前 projection/log/subscription delivery，再逐条 replay：
    // 任一普通 reducer 异常都会把 topic 留在半重放状态。候选 publisher 不承接订阅，
    // 完整 replay（含 logical size 校验）成功后才一次 adopt 权威数据面。
    let candidate = new ConversationTopicPublisher(this.sessionId, this.logEpoch, {
      now: this.now,
      retention: this.retention,
      subscriberBufferMaxOps: this.subscriberBufferMaxOps,
      subscriberBufferMaxBytes: this.subscriberBufferMaxBytes,
    });
    const usedBatchHydration = candidate.tryBatchHydration(events);
    if (!usedBatchHydration) {
      // 保守上界超限不代表权威 projection 一定超限；重新从空候选走原逐事件原子
      // admission，保留 16MiB fail-closed 与“拒绝单个 oversize 后继续终态”的旧语义。
      candidate = new ConversationTopicPublisher(this.sessionId, this.logEpoch, {
        now: this.now,
        retention: this.retention,
        subscriberBufferMaxOps: this.subscriberBufferMaxOps,
        subscriberBufferMaxBytes: this.subscriberBufferMaxBytes,
      });
      for (const event of events) {
        try {
          candidate.ingest(event);
        } catch (error) {
          if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
          if (!options.onPayloadTooLarge) throw error;
          options.onPayloadTooLarge(error);
        }
      }
    }

    this.projection = candidate.projection;
    if (usedBatchHydration) {
      // 批量重放会把派生 actions 延迟到最终 materialization；若允许客户端
      // 用逐事件旧快照的中间 base 续这份日志，batch 从未持有的旧 canEdit/canRetry 无法被
      // 定点撤销。rehydrate 本来就要求所有现有订阅 resync，因此在当前 seq 建立 snapshot
      // recovery boundary；此后新事件仍从该水位正常 resume，不改变 replayable 恢复语义。
      this.log.splice(0, this.log.length);
      this.floorSeq = candidate.currentSeq;
    } else {
      // strict fallback 没有延迟 materialization，完整保留原有 retained-log 恢复语义。
      this.log.splice(0, this.log.length, ...candidate.log);
      this.floorSeq = candidate.floorSeq;
    }
    this.wireSnapshotBytesUpperBound = candidate.wireSnapshotBytesUpperBound;
    for (const subscription of this.subscriptions.values()) {
      subscription.buffer = [];
      subscription.bufferBytes = 0;
      subscription.resyncRequired = true;
      subscription.sentSeq = 0;
      // adopt 后旧 projection 上预留的帧不可再 commit；失败 replay 从未触碰该 reservation。
      subscription.inFlight = null;
    }
  }

  /**
   * 冷恢复快路径：只修改尚未发布的 candidate。协议 wire snapshot 固定只含末尾 60 行，
   * 因此 row 更新只累计仍在 tail 的 delta，再给尚未 materialize 的 actions 按行预留
   * 完整 schema 上界；已滑出 tail 的保守增长在触及 payload limit 时通过精确测量消除。
   * 最终只做一次全行 actions 收敛，整体成本随事件/行数线性增长。
   */
  declare private tryBatchHydration: typeof part2.tryBatchHydration;

  declare private projectionLimitForEvent: typeof part2.projectionLimitForEvent;

  /**
   * 订阅裁决：base.logEpoch 匹配且 base.seq 在保留窗内 → resume，
   * 否则 snapshot。同 connectionId 重订阅 = 替换旧订阅并清其 flush buffer。
   */
  declare subscribe: typeof part2.subscribe;

  /** 生产 gateway 入口：初始帧也必须等 physical batch 全接受才 commit。 */
  declare subscribeReserved: typeof part3.subscribeReserved;

  declare unsubscribe: typeof part3.unsubscribe;

  declare hasSubscription: typeof part3.hasSubscription;

  /** Resident 回收判定：仍有任一订阅者时该会话不可被去激活。 */
  declare hasSubscribers: typeof part3.hasSubscribers;

  declare connectionIdForSubscription: typeof part3.connectionIdForSubscription;

  /**
   * 排空一个订阅者的 flush buffer 打成一帧（宿主按 flushWindowMs 驱动）。
   * 无新内容返回 null；帧区间 (sentSeq, currentSeq] 覆盖中途被过滤掉的 seq，
   * 保证客户端 `frame.fromSeq === store.seq` 的连续性判定不受 profile 过滤影响。
   */
  declare reserveFlush: typeof part3.reserveFlush;

  /** 旧单测便利面；生产 gateway 必须 reserve 后在 emit-all 成功才 commit。 */
  declare flush: typeof part3.flush;

  /**
   * 活跃订阅 same-sub 恢复：客户端 base 是唯一恢复起点，不能拿 sentSeq
   * 猜客户端已应用到哪里。新 recovery admission 会作废旧 reservation；迟到 commit
   * 因 inFlight 身份不再匹配而返回 false。
   */
  declare resyncReserved: typeof part4.resyncReserved;

  declare private resyncRollback: typeof part4.resyncRollback;

  declare private subscriberBufferLimits: typeof part4.subscriberBufferLimits;

  /** 溢出降级（05 §两级背压）：清缓冲、回发 snapshot 帧重对齐。 */
  declare resync: typeof part4.resync;

  declare private reserveFrame: typeof part4.reserveFrame;

  declare private subscribeResult: typeof part4.subscribeResult;

  declare private ackFor: typeof part5.ackFor;

  declare private frameShell: typeof part5.frameShell;
}

installV4OwnerMethods(ConversationTopicPublisher.prototype, part1);
installV4OwnerMethods(ConversationTopicPublisher.prototype, part2);
installV4OwnerMethods(ConversationTopicPublisher.prototype, part3);
installV4OwnerMethods(ConversationTopicPublisher.prototype, part4);
installV4OwnerMethods(ConversationTopicPublisher.prototype, part5);

export { coldHydrationJsonByteLength } from "./conversation-topic-publisher-log-entry.js";
export type { ConversationSubscribeParams } from "./conversation-topic-publisher-log-entry.js";
export type { ConversationSubscribeResult } from "./conversation-topic-publisher-log-entry.js";
export type { ConversationResyncRequest } from "./conversation-topic-publisher-log-entry.js";
export type { ConversationTopicPublisherOptions } from "./conversation-topic-publisher-log-entry.js";
export type { ConversationSubscriberBufferLimits } from "./conversation-topic-publisher-log-entry.js";
export { ProjectionPayloadTooLargeError } from "./conversation-topic-publisher-log-entry.js";
export { PROJECTION_TERMINAL_RESERVE_BYTES } from "./conversation-topic-publisher-log-entry.js";
export type { ConversationSubscriberBufferResult } from "./conversation-topic-publisher-log-entry.js";
export { conversationSubscriberBufferByteLimit } from "./conversation-topic-publisher-log-entry.js";
export { appendConversationSubscriberBuffer } from "./conversation-topic-publisher-log-entry.js";
