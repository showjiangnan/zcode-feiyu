// Modified by ZCode Feiyu.
import { type Actor, type AskNode } from "./scheduler-types.js";

import type { AskMessage, NodeRecord, SessionRef } from "./types.js";
import { refToString, WorkflowError } from "./types.js";
import type { AskScheduler } from "./scheduler.js";

export async function askSchedulerDispatch(this: AskScheduler, node: AskNode): Promise<void> {
  let session: SessionRef;
  try {
    session = await this["ensureSession"](node.actor);
  } catch (cause) {
    if (this["host"].isRunSettled() || node.settled) return;
    // 把 cause 的文本带进 message：WorkflowError.toJSON 只落 code/message，cause 不进 journal 也
    // 无人记日志，于是「创建 actor 会话失败」在 GUI / journal 里成了无法诊断的黑盒
    // （实机上底层其实是 session_task_link 的 FOREIGN KEY constraint failed）。
    this["settleFailed"](
      node,
      new WorkflowError(
        "DriverError",
        `Failed to create the subagent session: ${describeCause(cause)}`,
        { cause },
      ),
    );
    return;
  }
  if (this["host"].isRunSettled() || node.settled) return;
  // node-dispatched 在会话就绪之后（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）。进程级并发闸门
  // 不在这里：它按**模型请求**准入，住在 driver 之下的 runtime deps 里（决策 34/38）；调度器只守
  // per-run 的 ask 级上界（决策 17）。
  // 这一条重复该实例的出生事实（types.ts 的 `node-dispatched`）：调度器手上现成的那几样
  // 与它的 `node-queued` 同源，两个出生阶段名由引擎在 record 里按同一张铸造表补。
  this["host"].record({
    type: "node-dispatched",
    instance: node.instance,
    kind: "ask",
    actor: node.actor.ref,
    ...(node.actor.name === undefined ? {} : { actorName: node.actor.name }),
    ...(node.actor.persona.model === undefined
      ? {}
      : { actorPersonaModel: node.actor.persona.model }),
    ...(node.instructionsHead === undefined ? {} : { instructionsHead: node.instructionsHead }),
  });
  node.dispatched = true;
  const message: AskMessage = {
    instructions: node.instructions,
    typed: node.spec.typed,
    schema: node.spec.schema,
  };
  this["host"].driver.startAsk(session, node.instance, message);
}

export function askSchedulerEnsureSession(this: AskScheduler, actor: Actor): Promise<SessionRef> {
  if (actor.sessionPromise !== undefined) return actor.sessionPromise;
  // 种子只有到分歧点才知道（运行期发现），所以必须在这里、由引擎侧交给 driver——引擎持有
  // 导入态，driver 持有会话 store，这个签名是两者的最小汇合点。
  const seed = actor.imported?.seed();
  const promise = this["host"].driver
    .createActorSession(actor.ref, actor.persona, seed)
    .then((session) => {
      actor.session = session;
      // resolvedModel 由宿主侧的 runtime 工厂在 createActorSession **内部**写下（它才知道
      // "lite" 落到哪个模型）。putActor 是整条记录的替换，所以这条写入必须把刚写下的值读回来
      // 带过去，否则这里就会把它抹掉——档位解析的审计与 resume 依据随之丢失。
      const resolvedModel = this["journal"].getActor(
        this["host"].runId,
        actor.ref.siteId,
        actor.ref.ordinal,
      )?.resolvedModel;
      this["journal"].putActor({
        runId: this["host"].runId,
        siteId: actor.ref.siteId,
        ordinal: actor.ref.ordinal,
        name: actor.name,
        persona: actor.persona,
        sessionId: session.id,
        resolvedModel,
      });
      return session;
    });
  actor.sessionPromise = promise;
  return promise;
}

// ——————————————————————————————— 内部：结算 ———————————————————————————————

export function askSchedulerSettleOk(this: AskScheduler, node: AskNode, artifact: unknown): void {
  if (node.settled) return;
  node.settled = true;
  this["journal"].putNode(this["nodeRecordFor"](node, { status: "completed", result: artifact }));
  this["host"].record({ type: "node-settled", instance: node.instance, outcome: "ok" });
  this["finishLiveNode"](node);
  node.deferred.resolve(artifact);
}

export function askSchedulerSettleFailed(
  this: AskScheduler,
  node: AskNode,
  error: WorkflowError,
): void {
  if (node.settled) return;
  node.settled = true;
  // 结算失败必须落 journal（覆盖准入时的 running）：失败是"完结"，且脚本可能已观察到该 rejection
  // 并据此分支，replay 必须复现它——journal 化失败是重放正确性的硬性要求，而非可选。
  this["journal"].putNode(this["nodeRecordFor"](node, { status: "failed", error: error.toJSON() }));
  this["host"].record({
    type: "node-settled",
    instance: node.instance,
    outcome: "failed",
    error: error.toJSON(),
  });
  this["finishLiveNode"](node);
  // 节点失败只 reject 该 ask，不失败整个 run（脚本可 try/catch）。
  node.deferred.reject(error);
}

export function askSchedulerFinishLiveNode(this: AskScheduler, node: AskNode): void {
  this["liveNodes"].delete(refToString(node.instance));
  if (node.actor.current === node) {
    node.actor.current = undefined;
    this["activeAsks"]--;
  }
  this.pumpAll();
}

export function askSchedulerNodeRecordFor(
  this: AskScheduler,
  node: AskNode,
  outcome:
    | { status: "completed"; result: unknown }
    | { status: "failed"; error: NodeRecord["error"] },
): NodeRecord {
  const record: NodeRecord = {
    runId: this["host"].runId,
    siteId: node.instance.siteId,
    ordinal: node.instance.ordinal,
    kind: "ask",
    actorSiteId: node.actor.ref.siteId,
    actorOrdinal: node.actor.ref.ordinal,
    actorSeq: node.actorSeq,
    inputHash: node.hash,
    status: outcome.status,
  };
  if (outcome.status === "completed") record.result = outcome.result;
  else record.error = outcome.error;
  if (node.lastStats !== undefined)
    record.stats = this["journaledStats"](node.instance, node.lastStats);
  return record;
}

/** cause → 一行有界文本（Error 取 message，其余 String()；空则给占位）。 */
function describeCause(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  const trimmed = text.trim();
  if (trimmed.length === 0) return "unknown error";
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}
