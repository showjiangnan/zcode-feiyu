// Modified by ZCode Feiyu.
/**
 * ask 调度器：把"每 actor FIFO + hold 规则 + 并发上限派发 + ask 结算"从引擎主体拆出，
 * 使两个文件都聚焦、可读（并满足单文件行数上限）。引擎通过 {@link SchedulerHost} 注入其
 * 依赖（driver、caps、序号分配、run 级失败），调度器只负责 ask 生命周期，不管 run 生命周期。
 *
 * 关键规则见 engine.ts 顶部说明：命中短路、actorSeq 准入顺序、replay 的 hold 规则、串行 actor。
 *
 * 内部类型与 SchedulerHost 在 scheduler-types.ts；submit / turn 的向上回报处理在 scheduler-submit.ts
 * （拆分原因：oxlint max-lines 上限 400 行）。SchedulerHost 在此原地再导出，导入路径不变。
 * replay 命中的哈希不一致错误 {@link hashMismatch} 在 hash-mismatch.ts（同一个理由）。
 */

/**
 * ask 调度器：把"每 actor FIFO + hold 规则 + 并发上限派发 + ask 结算"从引擎主体拆出，
 * 使两个文件都聚焦、可读（并满足单文件行数上限）。引擎通过 {@link SchedulerHost} 注入其
 * 依赖（driver、caps、序号分配、run 级失败），调度器只负责 ask 生命周期，不管 run 生命周期。
 *
 * 关键规则见 engine.ts 顶部说明：命中短路、actorSeq 准入顺序、replay 的 hold 规则、串行 actor。
 *
 * 内部类型与 SchedulerHost 在 scheduler-types.ts；submit / turn 的向上回报处理在 scheduler-submit.ts
 * （拆分原因：oxlint max-lines 上限 400 行）。SchedulerHost 在此原地再导出，导入路径不变。
 * replay 命中的哈希不一致错误 {@link hashMismatch} 在 hash-mismatch.ts（同一个理由）。
 */
import { type CachedAskFacts } from "./cached-ask-facts.js";

import { type ImportedActorState } from "./imported-cache.js";
import { type Actor, type AskNode, type Deferred, type SchedulerHost } from "./scheduler-types.js";
import { handleSubmitAttempted, handleTurnEnded, type SubmitSeam } from "./scheduler-submit.js";
import type {
  ActorId,
  ActorRef,
  AskSpec,
  AskStats,
  InstanceRef,
  JournalStorePort,
  NodeRecord,
  PersonaSpec,
  SessionRef,
} from "./types.js";
import { refToString, WorkflowError } from "./types.js";
import {
  askSchedulerAdmitAsk,
  askSchedulerAdmitLive,
  askSchedulerTryImportedSettle,
  askSchedulerDrainAdmission,
  askSchedulerReleaseCachedAsk,
  askSchedulerSettleCachedAsk,
} from "./scheduler-admission.js";
import {
  askSchedulerDispatch,
  askSchedulerEnsureSession,
  askSchedulerSettleOk,
  askSchedulerSettleFailed,
  askSchedulerFinishLiveNode,
  askSchedulerNodeRecordFor,
} from "./scheduler-dispatch.js";

export type { SchedulerHost } from "./scheduler-types.js";

export class AskScheduler {
  private readonly actors = new Map<ActorId, Actor>();
  private readonly actorOrder: Actor[] = [];
  private readonly liveNodes = new Map<string, AskNode>();
  /**
   * 「转录早于本次派发」的 ask 实例（`siteId@ordinal`）：续跑前驱在飞 ask 的，以及 resume 时
   * 据 running 行重新派发的。它们落 journal 的 stats 要抹掉 `worldToolCalls`，见 {@link journaledStats}。
   * 结算后不清理——迟到的 stats 回填还要查它。
   */
  private readonly priorTranscriptAsks = new Set<string>();
  /**
   * 每个 actor 在 journal 里已记录的 ask 行数（`siteId@ordinal` → 行数），由引擎的 resume 分支用它
   * 已经读好的 ask 行一次建好（{@link seedRecordedAsks}）。修复原因：registerActor 原先每建一个
   * actor 就把整张节点表读一遍再过滤——宽扇出下是 O(actor × 行) 次解码，而且解的是每条 ask 的回答
   * 与每条 report item。一次建表是对的：actor 总在它的第一次 ask 之前注册，所以注册那一刻 journal
   * 里属于它的 ask 行只可能来自前几世；全新 run 的表为空。
   */
  private readonly recordedAsks = new Map<string, number>();
  private activeAsks = 0;

  /** scheduler-submit.ts 的自由函数经它查 live 节点、按结果结算（见 {@link SubmitSeam}）。 */
  private readonly submitSeam: SubmitSeam;

  constructor(private readonly host: SchedulerHost) {
    this.submitSeam = {
      host,
      liveNode: (instance) => this.liveNodes.get(refToString(instance)),
      settleOk: (node, artifact) => this.settleOk(node, artifact),
      settleFailed: (node, error) => this.settleFailed(node, error),
    };
  }

  private get journal(): JournalStorePort {
    return this.host.driver.journal;
  }

  /** resume 时喂入本 run 已落库的 ask 行（可不带结果），建好 {@link recordedAsks}。 */
  seedRecordedAsks(askRows: readonly NodeRecord[]): void {
    for (const row of askRows) {
      if (row.kind !== "ask" || row.actorSiteId === undefined || row.actorOrdinal === undefined) {
        continue;
      }
      const actorKey = refToString({ siteId: row.actorSiteId, ordinal: row.actorOrdinal });
      this.recordedAsks.set(actorKey, (this.recordedAsks.get(actorKey) ?? 0) + 1);
    }
  }

  hasActor(id: ActorId): boolean {
    return this.actors.has(id);
  }

  /**
   * 注册一个 actor（创建站点 × 序号）。`imported` 是 amend-resume 的导入候选：引擎已在
   * createActor 里按有效名 + 规范化 persona 匹配过，调度器只负责消费它。
   */
  registerActor(
    ref: ActorRef,
    id: ActorId,
    name: string | undefined,
    persona: PersonaSpec,
    imported?: ImportedActorState,
  ): Actor {
    const recordedCount = this.recordedAsks.get(refToString(ref)) ?? 0;
    const actor: Actor = {
      ref,
      id,
      persona,
      name,
      recordedCount,
      nextAdmitSeq: 0,
      pendingRecorded: new Map(),
      pendingLive: [],
      liveQueue: [],
      ...(imported === undefined ? {} : { imported }),
    };
    // 不能把 journal 记录的 sessionId 预解析成 actor.session/sessionPromise：
    // 让 resume 后的 ensureSession 跳过 driver.createActorSession。但生产 driver 的会话表
    // **只**在 createActorSession 里填充，startAsk 按表查会话——于是 resume 重新派发的每个
    // ask 都以「未知会话」失败。纯 replay（零派发）与 fake driver（startAsk 不查表）都暴露
    // 不了它。会话身份本就归 driver 所有（生产铸造函数按 (runId, actorRef) 纯确定，重挂时
    // 铸出同一个 id）；journal 的 dwf_actor.session_id 是记录、不是权威，所以这里绝不从
    // journal 短路会话——首次派发一律走 driver.createActorSession（见 ensureSession）。
    this.actors.set(id, actor);
    this.actorOrder.push(actor);
    return actor;
  }
  admitAsk(
    siteId: string,
    actorId: ActorId,
    instructions: string,
    spec: AskSpec,
  ): Promise<unknown> {
    return askSchedulerAdmitAsk.call(this, siteId, actorId, instructions, spec);
  }

  private admitLive(
    instance: InstanceRef,
    actor: Actor,
    seq: number,
    instructions: string,
    hash: string,
    spec: AskSpec,
    deferred: Deferred<unknown>,
    priorTranscript = false,
  ): void {
    return askSchedulerAdmitLive.call(
      this,
      instance,
      actor,
      seq,
      instructions,
      hash,
      spec,
      deferred,
      priorTranscript,
    );
  }

  private tryImportedSettle(
    instance: InstanceRef,
    actor: Actor,
    seq: number,
    hash: string,
    instructions: string,
    deferred: Deferred<unknown>,
  ): boolean {
    return askSchedulerTryImportedSettle.call(
      this,
      instance,
      actor,
      seq,
      hash,
      instructions,
      deferred,
    );
  }

  // ——————————————————————————————— 向上回报 ———————————————————————————————

  /** submit_result 到达：方法体在 scheduler-submit.ts 的 handleSubmitAttempted。 */
  submitAttempted(instance: InstanceRef, payload: unknown): void {
    handleSubmitAttempted(this.submitSeam, instance, payload);
  }

  /** turn 结束（无 submit）：方法体在 scheduler-submit.ts 的 handleTurnEnded。 */
  turnEnded(instance: InstanceRef, finalText: string): void {
    handleTurnEnded(this.submitSeam, instance, finalText);
  }

  noteStats(instance: InstanceRef, stats: AskStats): void {
    const node = this.liveNodes.get(refToString(instance));
    if (node !== undefined) {
      node.lastStats = stats;
      return;
    }
    // 节点已离开 liveNodes——typed-accept 主导路径：submit 停 turn 并在 settle 时落库，而真实
    // actor 的用量在 turn 解析后（submit 之后）才知道，故 stats 在结算之后才到达。回填已结算的
    // journal 记录：只新增/覆写 stats，保留 status/result/actorSeq/inputHash/error/kind/actor 身份。
    // 尽力而为且幂等；用量由 engine.askStats 记录（此处只补 journal 完整性）。
    const recorded = this.journal.getNode(this.host.runId, instance.siteId, instance.ordinal);
    if (recorded === undefined) return;
    this.journal.putNode({ ...recorded, stats: this.journaledStats(instance, stats) });
  }

  /**
   * 落 journal 的 stats：**转录早于本次派发**的 ask 抹掉 `worldToolCalls`。
   *
   * 根因：driver 的工具计数器是内存态、每次 ask 起跑时清零，所以接着一段既有转录跑的 ask 只数
   * 得到自己这几轮，转录里原有的工具调用一个也数不到。少报的后果不是账目不准（那是 tokens 的
   * 事），而是**纯度判据被污染**：一个报 0 的 ask 会被后来的修订当成纯条目，在关门之后仍从缓存
   * 结算——而它其实碰过工作区。缺席这个键本就表示「碰过」（保守读法），所以抹掉才是诚实记录。
   * tokens / toolCalls / turns 照记：它们是用量，不是纯度声明。
   */
  private journaledStats(instance: InstanceRef, stats: AskStats): AskStats {
    if (!this.priorTranscriptAsks.has(refToString(instance))) return stats;
    const { worldToolCalls: _unreliable, ...rest } = stats;
    return rest;
  }

  failed(instance: InstanceRef, error: WorkflowError): void {
    const node = this.liveNodes.get(refToString(instance));
    if (node === undefined || node.settled) return;
    this.settleFailed(node, error);
  }

  /** 该实例是否仍是在飞（已准入、未结算）的 live ask——限流观察事件只对这样的节点有意义。 */
  isLive(instance: InstanceRef): boolean {
    const node = this.liveNodes.get(refToString(instance));
    return node !== undefined && !node.settled;
  }

  /** 在飞 ask 所属子代理的有效名（关门事件里点名用）；不在飞即 undefined。 */
  liveActorName(instance: InstanceRef): string | undefined {
    const node = this.liveNodes.get(refToString(instance));
    return node === undefined || node.settled ? undefined : node.actor.persona.name;
  }

  /** 中止所有在飞 ask：run 取消/失败时用。emitCancelled 为真时补发 node-settled(cancelled)。 */
  abortInFlight(error: WorkflowError, emitCancelled: boolean): void {
    for (const node of this.liveNodes.values()) {
      if (node.settled) continue;
      node.settled = true;
      if (node.dispatched) this.host.driver.cancelAsk(node.instance);
      if (emitCancelled) {
        this.host.record({ type: "node-settled", instance: node.instance, outcome: "cancelled" });
      }
      node.deferred.reject(error);
    }
    this.liveNodes.clear();
    this.activeAsks = 0;
  }
  private drainAdmission(actor: Actor): void {
    return askSchedulerDrainAdmission.call(this, actor);
  }

  private releaseCachedAsk(
    instance: InstanceRef,
    recorded: NodeRecord,
    deferred: Deferred<unknown>,
    facts: CachedAskFacts,
  ): void {
    return askSchedulerReleaseCachedAsk.call(this, instance, recorded, deferred, facts);
  }

  private settleCachedAsk(
    instance: InstanceRef,
    recorded: NodeRecord,
    deferred: Deferred<unknown>,
    facts: CachedAskFacts,
  ): void {
    return askSchedulerSettleCachedAsk.call(this, instance, recorded, deferred, facts);
  }

  /**
   * 重扫每个 actor 的待派发队列。公开面**只为一个调用方**：引擎在抬高本 run 的并发上界之后
   * 调它（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）。上界本身是
   * {@link pumpActor} 每次派发前现读的，但没有任何别的事件会触发一次重扫——排队的 ask
   * 否则要一直等到下一次结算才动，而「抬高之后立刻多跑几个」正是这条命令买的东西。
   */
  pumpAll(): void {
    for (const actor of this.actorOrder) this.pumpActor(actor);
  }

  private pumpActor(actor: Actor): void {
    if (this.host.isRunSettled()) return;
    if (actor.current !== undefined) return;
    if (actor.liveQueue.length === 0) return;
    if (this.activeAsks >= this.host.caps.maxConcurrency) return;
    const node = actor.liveQueue.shift()!;
    actor.current = node;
    this.activeAsks++;
    void this.dispatch(node);
  }
  private async dispatch(node: AskNode): Promise<void> {
    return askSchedulerDispatch.call(this, node);
  }

  private ensureSession(actor: Actor): Promise<SessionRef> {
    return askSchedulerEnsureSession.call(this, actor);
  }

  private settleOk(node: AskNode, artifact: unknown): void {
    return askSchedulerSettleOk.call(this, node, artifact);
  }

  private settleFailed(node: AskNode, error: WorkflowError): void {
    return askSchedulerSettleFailed.call(this, node, error);
  }

  private finishLiveNode(node: AskNode): void {
    return askSchedulerFinishLiveNode.call(this, node);
  }

  private nodeRecordFor(
    node: AskNode,
    outcome:
      | { status: "completed"; result: unknown }
      | { status: "failed"; error: NodeRecord["error"] },
  ): NodeRecord {
    return askSchedulerNodeRecordFor.call(this, node, outcome);
  }
}
