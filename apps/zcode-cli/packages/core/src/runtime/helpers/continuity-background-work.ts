// Modified by ZCode Feiyu contributors (2026).
import type { TraceContext } from "../deps.js";
import { SessionEventType, traceContextToLogContext } from "../deps.js";
import type { BackgroundTaskStatus } from "@zcode/contracts";
import type { ContinuityBackgroundWorkKind } from "@zcode/shared/zcode-protocol-v4";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * 连续工作（记忆提取 / 记忆整理 / 主动执行）接进后台抽屉（复审 GAP-03）。
 *
 * 这里只做一件事：把**已经存在的**运行事实投影成会话事件流里的后台工作生命周期，
 * 让抽屉能在同一处显示正在做什么、以及一个走既有 `cancelBackgroundWork` 的停止入口。
 *
 * 刻意不做的事：
 * - 不持有运行状态。谁在跑仍由各自的所有者决定（提取调度器、整理任务、`runtime.proactiveWork`），
 *   本模块不缓存、不查询、不做去重表——同一 workId 重复发送由投影按 workId 覆盖处理。
 * - 不登记 runtime task registry。会话驻留与轮次收口只看 registry、active/queued turn、
 *   `residencyBlockingWorkCount` 与提取/整理任务本身；登记进 registry 会把「有工作在跑」
 *   变成「会话一直驻留」，那是对回收语义的回归（见 methods/residency.ts）。
 * - 不设 `toolName`。旧协议按工具名推断分区与停止分支；连续工作没有工具调用，
 *   留空即表示「只能由显式 taskKind 解释」，不会被推断成 bash 或 subagent。
 *
 * 事件写入失败只记录日志、不向上抛出：抽屉是展示面，不能让一条展示事件失败影响
 * 提取、整理或主动执行本身的结算。
 */
export interface ContinuityBackgroundWorkInput {
  kind: ContinuityBackgroundWorkKind;
  /** 抽屉行标题；协议没有独立的阶段/用量字段，阶段与用量由调用方写进这里。 */
  title: string;
  workId: string;
}

export async function startContinuityBackgroundWork(
  runtime: AgentRuntimeInternal,
  input: ContinuityBackgroundWorkInput & { cancellable?: boolean },
  traceContext: TraceContext,
): Promise<void> {
  await emitContinuityBackgroundWorkEvent(
    runtime,
    SessionEventType.BackgroundTaskStarted,
    { ...input, cancellable: input.cancellable ?? true, status: "running" },
    traceContext,
  );
}

/** 阶段或用量变化：只更新标题，不改生命周期状态（taskKind 只决定分区与图标）。 */
export async function updateContinuityBackgroundWork(
  runtime: AgentRuntimeInternal,
  input: ContinuityBackgroundWorkInput,
  traceContext: TraceContext,
): Promise<void> {
  await emitContinuityBackgroundWorkEvent(
    runtime,
    SessionEventType.BackgroundTaskUpdated,
    { ...input, status: "running" },
    traceContext,
  );
}

export async function settleContinuityBackgroundWork(
  runtime: AgentRuntimeInternal,
  input: ContinuityBackgroundWorkInput & { status: Exclude<BackgroundTaskStatus, "running"> },
  traceContext: TraceContext,
): Promise<void> {
  await emitContinuityBackgroundWorkEvent(
    runtime,
    SessionEventType.BackgroundTaskCompleted,
    input,
    traceContext,
  );
}

export type ContinuityReviewStage = "locate" | "gather" | "consolidate" | "prune" | "settle";

/**
 * 整理的抽屉条目句柄。
 *
 * 整理本身仍是阶段、用量与终态的唯一所有者：这里只保存「已经发布到抽屉的档位」这一展示水位，
 * 不缓存任何业务事实——调用方每次都把当前阶段与累计用量传进来。
 * 单独成句柄是为了限制 `project-memory-review.ts` 的规模（max-lines），
 * 同时让「阶段/用量怎么写进标题、多久发布一次」只有一处实现。
 */
export interface MemoryReviewBackgroundWork {
  readonly workId: string;
  /** 认领成功后开始。 */
  start(traceContext: TraceContext): Promise<void>;
  /** 阶段或用量变化；按 1,000 token 分档发布，避免每个模型请求都抬一次会话 revision。 */
  publishStage(
    stage: ContinuityReviewStage,
    totalTokens: number,
    traceContext: TraceContext,
  ): Promise<void>;
  settle(
    status: "completed" | "cancelled" | "failed",
    stage: ContinuityReviewStage,
    totalTokens: number,
    traceContext: TraceContext,
  ): Promise<void>;
}

export function createMemoryReviewBackgroundWork(
  runtime: AgentRuntimeInternal,
  reviewId: string,
): MemoryReviewBackgroundWork {
  let publishedStage: ContinuityReviewStage | undefined;
  let publishedTokens = -1;
  const title = (stage: ContinuityReviewStage, totalTokens: number) =>
    continuityBackgroundWorkTitle({
      kind: "memory_review",
      language: runtime.config.language,
      stage,
      totalTokens,
    });
  return {
    workId: reviewId,
    async start(traceContext) {
      publishedStage = "locate";
      publishedTokens = 0;
      await startContinuityBackgroundWork(
        runtime,
        { kind: "memory_review", title: title("locate", 0), workId: reviewId },
        traceContext,
      );
    },
    async publishStage(stage, totalTokens, traceContext) {
      const bucket = Math.floor(totalTokens / 1_000);
      if (stage === publishedStage && bucket === publishedTokens) return;
      publishedStage = stage;
      publishedTokens = bucket;
      await updateContinuityBackgroundWork(
        runtime,
        { kind: "memory_review", title: title(stage, totalTokens), workId: reviewId },
        traceContext,
      );
    },
    async settle(status, stage, totalTokens, traceContext) {
      await settleContinuityBackgroundWork(
        runtime,
        { kind: "memory_review", status, title: title(stage, totalTokens), workId: reviewId },
        traceContext,
      );
    },
  };
}

/**
 * 抽屉行标题。core 没有 i18n 依赖，而抽屉逐字渲染 `title`，所以在执行端按会话语言组句。
 *
 * 用词与设置页同一份产品词汇（`settings.memory.reviewProgress` 与
 * `settings.continuity.stage.*`），同一件事在两处不能出现两种说法。
 * 阶段与用量写进标题是协议现状：`backgroundWorkSummary` 没有独立的阶段/用量字段，
 * 界面也不自行推算（见 spec/agent-continuity/ui.md）。
 */
export function continuityBackgroundWorkTitle(input: {
  kind: ContinuityBackgroundWorkKind;
  language?: string;
  stage?: ContinuityReviewStage;
  /** 已知的累计 token 估算；未知时不写数字，宁可不显示也不编一个。 */
  totalTokens?: number;
}): string {
  const zh = (input.language ?? "").toLowerCase().startsWith("zh");
  if (input.kind === "memory_extraction") {
    return zh ? "正在提取记忆" : "Extracting memory";
  }
  if (input.kind === "proactive") {
    return zh ? "主动工作中" : "Proactive work running";
  }
  const stagesZh: Record<ContinuityReviewStage, string> = {
    consolidate: "整合记忆",
    gather: "采集会话",
    locate: "定位记忆",
    prune: "修剪过期记忆",
    settle: "结算",
  };
  const stagesEn: Record<ContinuityReviewStage, string> = {
    consolidate: "Consolidate",
    gather: "Gather",
    locate: "Locate",
    prune: "Prune",
    settle: "Settle",
  };
  const base = zh ? "正在整理记忆" : "Reviewing memory";
  const stage = input.stage ? ` · ${zh ? stagesZh[input.stage] : stagesEn[input.stage]}` : "";
  const usage =
    input.totalTokens && input.totalTokens > 0
      ? ` · ~${Math.round(input.totalTokens).toLocaleString("en-US")} ${zh ? "token" : "tokens"}`
      : "";
  return `${base}${stage}${usage}`;
}

async function emitContinuityBackgroundWorkEvent(
  runtime: AgentRuntimeInternal,
  type:
    | typeof SessionEventType.BackgroundTaskStarted
    | typeof SessionEventType.BackgroundTaskUpdated
    | typeof SessionEventType.BackgroundTaskCompleted,
  input: ContinuityBackgroundWorkInput & {
    cancellable?: boolean;
    status: BackgroundTaskStatus;
  },
  traceContext: TraceContext,
): Promise<void> {
  try {
    await runtime.appendEvent(
      runtime.createEvent(
        type,
        {
          taskId: input.workId,
          taskKind: input.kind,
          description: input.title,
          status: input.status,
          // 终态一律不可再取消：停止入口在结算之后不能再取消任何东西。
          cancellable: input.status === "running" ? (input.cancellable ?? true) : false,
        },
        traceContext,
      ),
      traceContext,
    );
  } catch (error) {
    runtime.logger?.warn?.("Continuity background work event was not recorded", {
      ...traceContextToLogContext(traceContext),
      event: "runtime.continuity_background_work.emit_failed",
      module: "core.runtime",
      taskId: input.workId,
      taskKind: input.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
