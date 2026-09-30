// Modified by ZCode Feiyu contributors (2026).
import type { WorkspaceMemoryOperation, WorkspaceMemoryResult } from "@zcode/shared";

export function normalizeMemoryWorkspaceDisplayName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "project"
  );
}

export function buildMemoryWorkspaceDisplayNameMap(
  names: readonly string[],
): ReadonlyMap<string, string> {
  const matches = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const candidate of names) {
    const displayName = candidate.trim();
    const slug = normalizeMemoryWorkspaceDisplayName(displayName);
    if (!displayName || ambiguous.has(slug)) continue;
    const existing = matches.get(slug);
    if (existing && existing !== displayName) {
      matches.delete(slug);
      ambiguous.add(slug);
      continue;
    }
    matches.set(slug, displayName);
  }
  return matches;
}

export type ContinuityPage<T> = {
  items: T[];
  nextCursor: string | null;
  expanded: boolean;
};

/** UI 分页投影，不保存第二份维护事实。轮询只更新头页，不能重置已加载尾页的游标。 */
export function mergeContinuityPage<T>(
  previous: ContinuityPage<T> | null,
  incoming: { items: T[]; nextCursor: string | null },
  key: (item: T) => string,
  mode: "refresh" | "append",
): ContinuityPage<T> {
  const items = new Map<string, T>();
  const ordered =
    mode === "append"
      ? [...(previous?.items ?? []), ...incoming.items]
      : [...incoming.items, ...(previous?.items ?? [])];
  for (const item of ordered) {
    if (!items.has(key(item))) items.set(key(item), item);
  }
  return {
    items: [...items.values()],
    nextCursor:
      mode === "refresh" && previous?.expanded ? previous.nextCursor : incoming.nextCursor,
    expanded: mode === "append" || previous?.expanded === true,
  };
}

/** 请求代只裁决 UI 回包；scope 切换和写操作使较早的查询失效，不能代替运行端版本。 */
export function createContinuityRequestGate() {
  let sequence = 0;
  return {
    begin: () => ++sequence,
    invalidate: () => {
      sequence += 1;
    },
    isCurrent: (request: number) => request === sequence,
  };
}

/**
 * 整理状态里「最新已结算的整理」标识（reviewId:status）；用于发现新的终态，据此刷新文件变更历史。
 * 当前记录已结算即以它为准；当前正在运行或空闲时，回退到运行列表里最近结算的一条，
 * 这样在两次轮询之间完整跑完、随即又有新整理开始的情形也能被发现。
 */
export function latestTerminalReviewKey(
  current: { reviewId?: string; status: string } | null | undefined,
  runs: readonly {
    reviewId: string;
    status: string;
    startedAt: number;
    finishedAt: number | null;
  }[],
): string | null {
  const settled = (status: string) =>
    status === "completed" || status === "failed" || status === "cancelled";
  if (current?.reviewId && settled(current.status)) return `${current.reviewId}:${current.status}`;
  let newest: { key: string; at: number } | null = null;
  for (const run of runs) {
    if (!settled(run.status)) continue;
    const at = run.finishedAt ?? run.startedAt;
    if (!newest || at > newest.at) newest = { key: `${run.reviewId}:${run.status}`, at };
  }
  return newest?.key ?? null;
}

export function memoryRevertOperation(
  revision: Extract<WorkspaceMemoryResult, { type: "revision" }>,
): Extract<WorkspaceMemoryOperation, { type: "revert" }> {
  // 历史 afterHash 不是当前文件修订；撤回必须使用用户打开详情时看到的 CAS 基线，包含 null。
  return {
    type: "revert",
    operationId: revision.entry.operationId,
    expectedHash: revision.currentHash,
  };
}

export function formatMemoryRunObservation(
  fact: {
    historyScope?: "workspace" | "current_session" | "none";
    sessionCount?: number;
    tokenUsageEstimated?: boolean;
  },
  locale: string,
  translate: (key: string) => string,
) {
  return {
    scope:
      fact.historyScope === undefined
        ? translate("notReported")
        : translate(`scope.${fact.historyScope}`),
    sessionCount:
      fact.sessionCount === undefined
        ? translate("notReported")
        : fact.sessionCount.toLocaleString(locale),
    usage: translate(
      fact.tokenUsageEstimated === true
        ? "usage.estimated"
        : fact.tokenUsageEstimated === false
          ? "usage.reported"
          : "usage.unknown",
    ),
  };
}

const KNOWN_PROACTIVE_REASONS = new Set([
  "permission_disabled",
  "permission_revoked",
  "user_control",
]);

export function formatContinuityReason(
  reason: string,
  translate: (key: string, values?: Record<string, string | number>) => string,
): string {
  // 旧端暂停只能显式启动或由新版执行端迁移，UI 不改写持久状态。
  if (
    reason.startsWith("budget_exhausted:") ||
    reason.startsWith("turn_limit:") ||
    reason === "budget_exhausted"
  )
    return translate("reason.legacy_execution_limit");
  return KNOWN_PROACTIVE_REASONS.has(reason) ? translate(`reason.${reason}`) : reason;
}

/**
 * running 的展示细分（复审 GAP-04）。
 *
 * 修复原因：协议只有 stopped/running/paused，界面分不清「正在跑模型」与「订阅就绪、等下一次事件」，
 * 休眠时也显示加载反馈，看起来像卡在等待模型返回。依据：ui.md 要求休眠不得使用「等待模型返回」的动画。
 * 旧执行端不带 runtimeState 时按 working 处理：宁可多给一次活动反馈，也不要漏报真实工作。
 */
export function resolveProactiveRuntimeState(state?: {
  status?: "stopped" | "running" | "paused";
  runtimeState?: "sleeping" | "working";
}): { label: "sleeping" | "working" | null; busy: boolean } {
  if ((state?.status ?? "stopped") !== "running") return { label: null, busy: false };
  const runtimeState = state?.runtimeState ?? "working";
  return { label: runtimeState, busy: runtimeState === "working" };
}
