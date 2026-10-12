// Modified by ZCode Feiyu.
import type { SessionEvent, DynamicWorkflowRunProgressPayload } from "@zcode/contracts";
import type {
  ConversationDelta,
  BackgroundWorkKind,
  BackgroundWorkSummary,
  WorkflowRunProgressEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import { resolveZCodeBackgroundTaskControlKind } from "@zcode/shared";
import { explicitBackgroundWorkKind } from "./product-projection-stream-recovery-reason-code.js";
import {
  isContinuityBackgroundWorkKind,
  reduceWorkflowRunsState,
  diffWorkflowRunsState,
} from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjection } from "./product-projection.js";

export function onBackgroundTaskLifecycle(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    taskId?: string;
    toolName?: string;
    taskKind?: string;
    command?: string;
    description?: string;
    status?: string;
    cancellable?: boolean;
    blocked?: boolean;
    childSessionId?: string;
  };
  const workId = payload.taskId;
  if (!workId) return [];
  const prev = this["snapshot"].backgroundWorks;
  const existing = prev.find((work) => work.workId === workId);
  const legacyKind = resolveZCodeBackgroundTaskControlKind(payload);
  // 新事件使用 runtime 的显式 taskKind；旧事件统一走 shared resolver，
  // 不能再在 reducer 内散落 Agent/Task/subagent 字符串分支。
  // "workflow" 是 workflow run（此前错标成 bash）；legacy resolver 里没有对应值，因为
  // legacy `Workflow` 工具刻意仍归 bash——两者是不同的东西，共用类别会让面板混在一起。
  const explicitKind = explicitBackgroundWorkKind(
    payload.taskKind as BackgroundWorkKind | undefined,
  );
  const kind: BackgroundWorkSummary["kind"] =
    explicitKind ??
    (legacyKind === "agent"
      ? "subagent"
      : legacyKind === "bash"
        ? "bash"
        : (existing?.kind ?? "bash"));
  // 事件 status（running/completed/failed/timed_out/cancelled/spawn_error/lost）
  // → summary status（running/resultPending/failed/cancelled）。
  const rawStatus = payload.status ?? "running";
  const status: "running" | "resultPending" | "failed" | "cancelled" =
    rawStatus === "running"
      ? "running"
      : rawStatus === "cancelled"
        ? "cancelled"
        : rawStatus === "completed"
          ? "resultPending"
          : "failed";
  const title =
    payload.description?.trim() ||
    payload.command?.trim() ||
    existing?.title ||
    payload.toolName ||
    workId;
  // 连续工作的终态**移除**条目，不留 resultPending（复审 GAP-03）。
  // 原因：summary.status 的 resultPending 语义是「结果在 continuation inbox 等待前台空闲，
  // 投递后条目消失」，而提取/整理/主动执行没有这样的投递；保留它等于声明一个永不落地的结果。
  // 另外提取按轮次发生，终态条目会让 backgroundWorks 随轮数无界增长，且它在
  // REVISION_BEARING_PATCH_KEYS 里：每个旧条目都会随每次状态变化重发一遍。
  // 抽屉的记忆与主动工作分区是实时视图（只渲染 running），移除不丢可见信息；
  // bash / subagent / workflow 的既有保留语义不变。
  if (
    explicitKind !== undefined &&
    isContinuityBackgroundWorkKind(explicitKind) &&
    status !== "running"
  ) {
    // 没有对应 running 条目时无事可做（冷回放的事件流被裁剪过）：不产 delta。
    if (!existing) return [];
    return [
      {
        op: "state.updated",
        patch: { backgroundWorks: prev.filter((work) => work.workId !== workId) },
      },
    ];
  }
  const next: BackgroundWorkSummary = {
    workId,
    kind,
    title,
    status,
    startedAt: existing?.startedAt ?? this["ms"](event),
    ...(status === "running" ? {} : { endedAt: this["ms"](event) }),
    ...(typeof payload.cancellable === "boolean"
      ? { cancellable: payload.cancellable }
      : existing?.cancellable !== undefined
        ? { cancellable: existing.cancellable }
        : {}),
    ...(typeof payload.blocked === "boolean"
      ? { blocked: payload.blocked }
      : existing?.blocked !== undefined
        ? { blocked: existing.blocked }
        : {}),
    anchorRowId: existing?.anchorRowId ?? null,
    ...(payload.childSessionId
      ? { childSessionId: payload.childSessionId }
      : existing?.childSessionId
        ? { childSessionId: existing.childSessionId }
        : {}),
  };
  // 幂等：内容无变化不产 delta。
  if (
    existing &&
    existing.status === next.status &&
    existing.title === next.title &&
    existing.kind === next.kind &&
    existing.cancellable === next.cancellable &&
    existing.blocked === next.blocked &&
    existing.childSessionId === next.childSessionId
  ) {
    return [];
  }
  const backgroundWorks = existing
    ? prev.map((work) => (work.workId === workId ? next : work))
    : [...prev, next];
  return [{ op: "state.updated", patch: { backgroundWorks } }];
}

export function onDynamicWorkflowRunProgress(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  // 先转 contracts 的有界 payload、再赋给 shared 的结构化入参：这行赋值就是"两边形状不漂移"
  // 的编译期闸（shared 不得反向依赖 contracts，所以入参类型只能结构化定义）。
  const envelope: WorkflowRunProgressEnvelope = event.payload as DynamicWorkflowRunProgressPayload;
  const prior = this["snapshot"].workflowRuns;
  const workflowRuns = reduceWorkflowRunsState(prior, envelope);
  // null = 语义无变化（无效事件或同一条事件重放）：不产 delta，revision 不抬。
  if (workflowRuns === null) return [];
  // 发**差**而不是整键：一条引擎事件只动一个节点，整键重发是每事件 O(N) 字节、一条 run
  // 全程 O(N²)（workflow-runs-delta.ts 的文件头讲了这笔账怎么变成节点上界和 UI 卡死的）。
  // `applyAll(prior, diff(prior, next))` 与 next **逐字节**一致是被 property 测试钉住的契约，
  // 所以 applyEventInternal 把这串 delta 应用回去之后，this.snapshot.workflowRuns 仍是 next。
  return diffWorkflowRunsState(prior, workflowRuns);
}

export function removeQueueItems(
  this: ProductProjection,
  ids: readonly string[],
): ConversationDelta[] {
  const idSet = new Set(ids);
  for (const id of ids) this["deliveryByPendingInputId"].delete(id);
  const items = this["snapshot"].queue.items
    .filter((item) => !idSet.has(item.queueItemId))
    .map((item, index) =>
      item.order.queuePosition === index
        ? item
        : { ...item, order: { ...item.order, queuePosition: index } },
    );
  if (items.length === this["snapshot"].queue.items.length) return [];
  return [
    {
      op: "state.updated",
      patch: this["queuePatch"]({ ...this["snapshot"].queue, items }),
    },
  ];
}
