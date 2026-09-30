// Modified by ZCode Feiyu contributors (2026).
// ============================================================
// 连续工作（记忆提取 / 记忆整理 / 主动执行）的后台停止分支
// （runtime.stopBackgroundTask 的 memory_extraction / memory_review / proactive 分派）
// ============================================================
//
// 复审 GAP-03：后台抽屉把这三类工作也列成条目，于是它们进入同一个停止入口
// （v4 `cancelBackgroundWork {workId}` → `app.cancelBackgroundTask` →
// `runtime.cancelBackgroundTask` → `runtime.stopBackgroundTask`）。本模块只做**分派**：
// 三类工作各有自己的所有者与已授权的停止路径，这里不新建取消能力，也不复制它们的收口逻辑。
//
// 与 bash / subagent / workflow 的差别只有一处：连续工作不登记 runtime task registry
// （登记会把「有工作在跑」变成「会话一直驻留」，见 methods/residency.ts），因此没有
// `RuntimeTaskType`，只按投影条目上的 `taskKind` 分派。
//
// 单独成模块是为了限制 background.ts 的规模（max-lines），background.ts 侧只保留一个
// import 与一行分派——与 background-stop-dynamic-workflow.ts 同一约定。

import type { ContinuityBackgroundWorkKind } from "@zcode/shared/zcode-protocol-v4";
import type { AgentRuntimeInternal } from "../internal.js";
import { controlRuntimeProactiveWork } from "../orchestration.js";
import { traceContextToLogContext } from "../deps.js";
import type {
  RuntimeBackgroundStopOptions,
  RuntimeBackgroundStopResult,
  RuntimeBackgroundStopTarget,
} from "./background-stop-types.js";

/**
 * 停止一个连续工作条目。
 *
 * 分派规则（每条都指向**已经存在**的授权路径）：
 * - `memory_review` → `cancelProjectMemoryReview(reviewId)`：与工作区级 `cancelReview` 命令在运行端的
 *   同一条收口（迟到取消按原 reviewId 拒绝，见 project-memory-review 的租约复核）。
 * - `proactive` → `controlRuntimeProactiveWork("stop", …, "user_control")`：主动工作自己定义的停止，
 *   原因沿用既有 `user_control` 文案，不把它写成预算或轮次暂停。
 * - `memory_extraction` → 只中止当前这一轮（调度器的运行作用域），不关闭调度器、不影响后续提取。
 *
 * 已经终结的条目按 bash 分支同一语义返回（strict 时如实回 not_running）；取消不到任何东西时
 * 也如实回 `background_task_not_running`，不假装成功。
 */
export async function stopContinuityBackgroundWork(
  this: AgentRuntimeInternal,
  target: RuntimeBackgroundStopTarget,
  kind: ContinuityBackgroundWorkKind,
  options: RuntimeBackgroundStopOptions,
): Promise<RuntimeBackgroundStopResult> {
  const taskId = target.taskId;
  if (isTerminalStatus(target.existing?.status)) {
    if (options.strict) {
      return {
        ok: false,
        reason: "background_task_not_running",
        status: target.existing?.status,
        taskId,
      };
    }
    return {
      alreadyTerminal: true,
      ok: true,
      status: target.existing?.status ?? "lost",
      taskId,
    };
  }
  if (kind === "memory_review") {
    if (!this.cancelProjectMemoryReview(taskId)) {
      // 运行端已经没有在跑的同 id 整理（可能是别的 runtime 认领的）：如实回「没有取消任何东西」。
      return { ok: false, reason: "background_task_not_running", status: "lost", taskId };
    }
    return { ok: true, status: "cancelled", taskId };
  }
  if (kind === "memory_extraction") {
    const cancelled = this.memoryExtractionScheduler?.cancelCurrent(
      new Error("Memory extraction cancelled from the background work panel"),
    );
    if (!cancelled) {
      return { ok: false, reason: "background_task_not_running", status: "lost", taskId };
    }
    return { ok: true, status: "cancelled", taskId };
  }
  try {
    // 停止是主动工作自己的状态转换（paused/stopped + 代次递增 + 取消在途轮次），
    // 由它等待本轮 settled，抽屉不需要第二套停止实现。
    await controlRuntimeProactiveWork(this, "stop", undefined, "user_control");
  } catch (error) {
    this.logger?.warn?.("Proactive work stop was rejected", {
      ...traceContextToLogContext(options.traceContext ?? this.rootTraceContext),
      event: "runtime.proactive_work.stop_rejected",
      module: "core.runtime",
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: "background_task_cancel_not_supported", taskId };
  }
  return { ok: true, status: "cancelled", taskId };
}

function isTerminalStatus(status: string | undefined): boolean {
  return Boolean(status && status !== "running");
}
