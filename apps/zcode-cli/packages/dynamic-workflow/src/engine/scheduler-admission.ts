// Modified by ZCode Feiyu.
import { cachedAskFacts, headOfInstructions, type CachedAskFacts } from "./cached-ask-facts.js";
import { inputHash } from "./hash.js";
import { hashMismatch } from "./hash-mismatch.js";
import { importedAskRecord } from "./imported-cache.js";
import { defer, type Actor, type AskNode, type Deferred } from "./scheduler-types.js";

import type { ActorId, AskSpec, InstanceRef, NodeRecord } from "./types.js";
import { NUDGE_ATTEMPTS, refToString, REPAIR_ATTEMPTS, WorkflowError } from "./types.js";
import type { AskScheduler } from "./scheduler.js";

/** 受理一次 ask：完结命中短路（走 hold 规则），running 命中或未命中则 live 派发。 */

export function askSchedulerAdmitAsk(
  this: AskScheduler,
  siteId: string,
  actorId: ActorId,
  instructions: string,
  spec: AskSpec,
): Promise<unknown> {
  const actor = this["actors"].get(actorId)!;
  const ordinal = this["host"].nextOrdinal(siteId);
  const instance: InstanceRef = { siteId, ordinal };
  const hash = inputHash(instructions);
  const deferred = defer<unknown>();

  const recorded = this["journal"].getNode(this["host"].runId, siteId, ordinal);
  if (recorded !== undefined) {
    // 命中即防御性校验 inputHash——不一致说明纯度契约被破坏，run 大声失败。
    if (recorded.inputHash !== hash) {
      const err = hashMismatch(instance, recorded.inputHash, hash);
      this["host"].failRun(err);
      return Promise.reject(err);
    }
    const seq = recorded.actorSeq ?? 0;
    const reconcile = (): void =>
      actor.imported?.reconcileRecorded(
        seq,
        recorded.inputHash,
        this["host"].wasLiveBeforeResume(instance),
        this["host"].wasQueuedBeforeImportClose(instance),
      );
    if (recorded.status === "running") {
      // 崩溃于执行中：按记录的 actorSeq 位置重新 live 派发（hold 规则保证其准入次序）。
      // 这一条的转录里已经有上一轮跑出来的那些消息，所以按「转录早于本次派发」记 stats。
      actor.pendingRecorded.set(seq, () => {
        reconcile();
        this["admitLive"](instance, actor, seq, instructions, hash, spec, deferred, true);
      });
    } else {
      // completed / failed：短路结算，无 driver 调用。出生事实在 reconcile 之后**当场**取
      // （答案是否读自前驱的转录，看的是此刻的导入消费态；事件可能被结算次序闸推迟）。
      actor.pendingRecorded.set(seq, () => {
        reconcile();
        this["releaseCachedAsk"](
          instance,
          recorded,
          deferred,
          cachedAskFacts(actor.ref, seq, instructions, actor.imported),
        );
      });
    }
    this["drainAdmission"](actor);
    return deferred.promise;
  }

  // 未命中（fresh）：注册到 pendingLive，按到达顺序在记录节点排空后准入并分配新的 actorSeq。
  // 分配到 seq 之后先问导入缓存（amend-resume）：命中即 cached settle，不 live。
  actor.pendingLive.push(() => {
    const seq = actor.nextAdmitSeq++;
    if (this["tryImportedSettle"](instance, actor, seq, hash, instructions, deferred)) return;
    // 未命中之后才知道它是不是「续跑前驱的在飞 ask」——判定在 take 里随分歧一起做出。
    const carried = actor.imported?.carriedAt(seq) === true;
    this["admitLive"](instance, actor, seq, instructions, hash, spec, deferred, carried);
  });
  this["drainAdmission"](actor);
  this.pumpAll();
  return deferred.promise;
}

/**
 * 把一个 ask 作为 live 节点准入：建节点、准入即落 running 记录、入队并记事件。
 *
 * `priorTranscript` 为真表示这一条不是从空转录开跑的（续跑前驱在飞 ask，或 resume 据 running
 * 行重新派发）——它只影响 stats 怎么落库，见 {@link journaledStats}。
 */

export function askSchedulerAdmitLive(
  this: AskScheduler,
  instance: InstanceRef,
  actor: Actor,
  seq: number,
  instructions: string,
  hash: string,
  spec: AskSpec,
  deferred: Deferred<unknown>,
  priorTranscript = false,
): void {
  if (priorTranscript) this["priorTranscriptAsks"].add(refToString(instance));
  // 指令开头随出生事件一起落轨（docs/execution-engine.md「Events」）：这里的 instructions 还是
  // 作者的原文——driver 的质量 / schema 尾注在 startAsk 里才追加，所以摘要里不会混进引擎的话。
  // 算一次存在节点上：派发要重复出生事实，两条事件带的必须是同一个串。
  const instructionsHead = headOfInstructions(instructions);
  const node: AskNode = {
    instance,
    actor,
    actorSeq: seq,
    instructions,
    hash,
    spec,
    deferred,
    repairsRemaining: REPAIR_ATTEMPTS,
    nudgesRemaining: NUDGE_ATTEMPTS,
    settled: false,
    dispatched: false,
    ...(instructionsHead === undefined ? {} : { instructionsHead }),
  };
  this["liveNodes"].set(refToString(instance), node);
  // 准入即落 running（携 actorSeq + inputHash）：崩溃于执行中的节点 resume 可据此重新派发。
  this["journal"].putNode({
    runId: this["host"].runId,
    siteId: instance.siteId,
    ordinal: instance.ordinal,
    kind: "ask",
    actorSiteId: actor.ref.siteId,
    actorOrdinal: actor.ref.ordinal,
    actorSeq: seq,
    inputHash: hash,
    status: "running",
  });
  actor.liveQueue.push(node);
  this["host"].record({
    type: "node-queued",
    instance,
    kind: "ask",
    actor: actor.ref,
    actorSeq: seq,
    ...(instructionsHead === undefined ? {} : { instructionsHead }),
  });
  // 转 live **不**关导入缓存。曾经在这里关：任一 ask live
  // 即视为工作区可能被改写。那是拿时钟代替依赖——同一个 Promise.all 里排在第一个未命中之后的
  // 兄弟 ask 全被判失效，而它们之间没有任何依赖（实测 50 路扇出丢 6 个命中，5 路扇出
  // 丢掉唯一的 1 个）。现在关门的是**第一笔写入**：driver 在子代理即将执行改写工具时上报
  // askMutating，或一条 world.run live 执行；在此之前的世界与前驱留下的世界相同，缓存命中都成立。
}

/**
 * fresh ask 准入时问一次导入缓存（amend-resume）。命中即 **cached settle** 并返回 true
 * （调用方不再 live）；判定与分歧记账全在 {@link ImportedActorState}。
 *
 * 命中写一行**真** dwf_node，只发 `node-settled cached:true`——与 replay 命中的
 * {@link releaseCachedAsk} 同一副姿态：不发 node-queued / node-dispatched，
 * 不入 liveQueue，不建会话，不占 `actor.current`。那条结算因此就是出生事件，重发出生事实，
 * 并点名前驱里持有这段交换的会话（{@link cachedAskFacts}）。
 */

export function askSchedulerTryImportedSettle(
  this: AskScheduler,
  instance: InstanceRef,
  actor: Actor,
  seq: number,
  hash: string,
  instructions: string,
  deferred: Deferred<unknown>,
): boolean {
  // 缓存已关闭 ⇒ 只放**纯** ask（前驱记下 toolCalls === 0）：它只依赖指令与转录前缀，与工作区
  // 无关，所以对旧世界的答案对新世界同样成立；带工具的条目即便同哈希也转 live——它读过的
  // 工作区可能已被改写。转 live 的那个 ask 让该 actor 分歧（转录从此不同），已消费前缀仍是种子
  // 边界的依据。
  const entry = this["host"].importCacheClosed()
    ? actor.imported?.takeIfPure(seq, hash)
    : actor.imported?.take(seq, hash);
  if (entry === undefined) return false;
  this["journal"].putNode(
    importedAskRecord(this["host"].runId, instance, actor.ref, seq, hash, entry),
  );
  const facts = cachedAskFacts(actor.ref, seq, instructions, actor.imported);
  this["host"].record({ type: "node-settled", instance, outcome: "ok", cached: true, ...facts });
  deferred.resolve(entry.result);
  return true;
}

// ——————————————————————————————— 内部：准入 / 派发 ———————————————————————————————

export function askSchedulerDrainAdmission(this: AskScheduler, actor: Actor): void {
  let progressed = true;
  while (progressed) {
    progressed = false;
    const release = actor.pendingRecorded.get(actor.nextAdmitSeq);
    if (release !== undefined) {
      actor.pendingRecorded.delete(actor.nextAdmitSeq);
      actor.nextAdmitSeq++;
      release();
      progressed = true;
      continue;
    }
    if (actor.nextAdmitSeq >= actor.recordedCount && actor.pendingLive.length > 0) {
      const admit = actor.pendingLive.shift()!;
      admit();
      progressed = true;
    }
  }
  this["pumpActor"](actor);
}

/**
 * 命中记录的 ask：按 journal 记下的**结算次序**释放（docs/execution-engine.md
 * 「Replaying the settle order」）。hold 规则定的是同一个 actor 内的准入次序，跨 actor 的
 * 完成次序要这一道闸才回得来——扇出分支在 await 之后的每一次 journal 调用都按它编号。
 */

export function askSchedulerReleaseCachedAsk(
  this: AskScheduler,
  instance: InstanceRef,
  recorded: NodeRecord,
  deferred: Deferred<unknown>,
  facts: CachedAskFacts,
): void {
  this["host"].holdForReplay(instance, () =>
    this["settleCachedAsk"](instance, recorded, deferred, facts),
  );
}

export function askSchedulerSettleCachedAsk(
  this: AskScheduler,
  instance: InstanceRef,
  recorded: NodeRecord,
  deferred: Deferred<unknown>,
  facts: CachedAskFacts,
): void {
  if (recorded.status === "completed") {
    this["host"].record({ type: "node-settled", instance, outcome: "ok", cached: true, ...facts });
    deferred.resolve(recorded.result);
  } else {
    // 已记录的失败也要短路复现：脚本可能已 try/catch 过它并据此分支，replay 必须重放同一 rejection。
    this["host"].record({
      type: "node-settled",
      instance,
      outcome: "failed",
      cached: true,
      error: recorded.error,
      ...facts,
    });
    deferred.reject(WorkflowError.fromJSON(recorded.error!));
  }
}
