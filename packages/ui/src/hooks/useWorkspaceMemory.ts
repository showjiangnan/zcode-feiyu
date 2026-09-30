// Modified by ZCode Feiyu contributors (2026).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MemoryHistorySummary,
  MemoryReviewRun,
  WorkspaceMemoryOperation,
  WorkspaceMemoryResult,
  ZCodeTaskMeta,
  ZCodeAutomation,
} from "@zcode/shared";
import {
  createContinuityRequestGate,
  latestTerminalReviewKey,
  mergeContinuityPage,
  type ContinuityPage,
} from "./continuityProjection.js";
import type { IMemoryService, ProjectMemoryWorkspaceSummary } from "@zcode/services";
import { useServices } from "./useServices.js";
import { useModelSelectionServiceView } from "./useModelSelectionView.js";

export function useWorkspaceMemory(workspacePath: string, loadAutomations = false) {
  const services = useServices();
  const model = useModelSelectionServiceView(services.modelSelectionService);
  const [automations, setAutomations] = useState<ZCodeAutomation[]>([]);
  const [tasks, setTasks] = useState<ZCodeTaskMeta[]>([]);
  const [taskError, setTaskError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setTasks([]);
    setAutomations([]);
    setTaskError(null);
    if (workspacePath)
      void services.zcodeTaskService
        .listTasks({ workspacePath })
        .then((value) => {
          if (current) setTasks(value);
        })
        .catch((error: unknown) => {
          if (current) setTaskError(error instanceof Error ? error.message : String(error));
        });
    if (workspacePath && loadAutomations)
      void services.zcodeAgentService
        .listAutomations({ workspacePath })
        .then((value) => {
          if (current) setAutomations(value);
        })
        .catch((error: unknown) => {
          if (current) setTaskError(error instanceof Error ? error.message : String(error));
        });
    return () => {
      current = false;
    };
  }, [services.zcodeTaskService, services.zcodeAgentService, workspacePath, loadAutomations]);
  const execute = useCallback(
    (operation: WorkspaceMemoryOperation) => {
      if (!workspacePath) throw new Error("Select a local workspace");
      return services.zcodeAgentService.workspaceMemory({ workspacePath, operation });
    },
    [services.zcodeAgentService, workspacePath],
  );
  return {
    execute,
    tasks,
    automations,
    taskError,
    model: model.state.status === "ready" ? model.state.view.preferredSelection : null,
  };
}

type MemoryStatus = Extract<WorkspaceMemoryResult, { type: "status" }>;
type MemoryProjection = {
  current: MemoryStatus["current"];
  runs: ContinuityPage<MemoryReviewRun> | null;
  history: ContinuityPage<MemoryHistorySummary> | null;
  /** 自动整理的门槛进度；旧执行端不提供时为 null，界面按未知处理（复审 GAP-05）。 */
  thresholdProgress: MemoryStatus["thresholdProgress"] | null;
};
const EMPTY_PROJECTION: MemoryProjection = {
  current: null,
  runs: null,
  history: null,
  thresholdProgress: null,
};
const runKey = (run: MemoryReviewRun) => run.reviewId;
const historyKey = (entry: MemoryHistorySummary) => entry.operationId;
const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** 当前 scope 的只读查询投影；运行状态始终来自 Host，分页只保留用户已加载的页面。 */
export function useMemoryMaintenance(
  execute: ReturnType<typeof useWorkspaceMemory>["execute"],
  enabled: boolean,
) {
  const [projection, setProjection] = useState(EMPTY_PROJECTION);
  const [projectionOwner, setProjectionOwner] = useState(() => execute);
  const [errors, setErrors] = useState<
    Partial<Record<"status" | "history" | "runsPage" | "historyPage", string | null>>
  >({});
  const statusPending = useMemo(() => ({ count: 0 }), [execute]);
  const [loading, setLoading] = useState(enabled);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const gates = useMemo(
    () => ({
      status: createContinuityRequestGate(),
      history: createContinuityRequestGate(),
      runsPage: createContinuityRequestGate(),
      historyPage: createContinuityRequestGate(),
    }),
    [execute],
  );
  const owner = useRef(execute);
  owner.current = execute;
  const active = useRef(false);
  const pagePending = useRef({ runs: false, history: false });
  const currentOwner = useCallback(() => active.current && owner.current === execute, [execute]);

  const refreshHistory = useCallback(async () => {
    if (!enabled) return;
    const request = gates.history.begin();
    try {
      const result = await execute({ type: "history" });
      if (!currentOwner() || !gates.history.isCurrent(request) || result.type !== "history") return;
      setProjection((previous) => ({
        ...previous,
        history: mergeContinuityPage(
          previous.history,
          { items: result.entries, nextCursor: result.nextCursor },
          historyKey,
          "refresh",
        ),
      }));
      setErrors((previous) => ({ ...previous, history: null }));
    } catch (cause) {
      if (currentOwner() && gates.history.isCurrent(request))
        setErrors((previous) => ({ ...previous, history: errorMessage(cause) }));
    }
  }, [currentOwner, enabled, execute, gates]);
  // 已观察到的最近一次已结算整理；undefined 表示还没有基线（首次读取只建立基线，不额外触发历史刷新）。
  const settledReview = useRef<string | null | undefined>(undefined);
  const refreshStatus = useCallback(async () => {
    if (!enabled) return;
    statusPending.count += 1;
    const request = gates.status.begin();
    try {
      const result = await execute({ type: "status" });
      if (!currentOwner() || !gates.status.isCurrent(request) || result.type !== "status") return;
      // 修复原因：5 秒轮询只刷新状态与运行列表，自动整理完成后文件变更历史停留在整理前，
      // 用户看不到刚写入的变更，只能重新进入页面（复审 DEF-23）。
      // 依据：出现新的已结算整理（含两次轮询之间完整跑完的）即历史已变化，同时补刷历史。
      const settled = latestTerminalReviewKey(result.current, result.runs);
      const baseline = settledReview.current;
      settledReview.current = settled;
      setProjection((previous) => ({
        ...previous,
        current: result.current,
        // 门槛进度始终取最新一次状态读取：它是「距上次成功后已变化多少会话」的即时事实。
        thresholdProgress: result.thresholdProgress ?? null,
        runs: mergeContinuityPage(
          previous.runs,
          { items: result.runs, nextCursor: result.nextCursor },
          runKey,
          "refresh",
        ),
      }));
      setErrors((previous) => ({ ...previous, status: null }));
      if (baseline !== undefined && settled !== null && settled !== baseline) void refreshHistory();
    } catch (cause) {
      if (currentOwner() && gates.status.isCurrent(request))
        setErrors((previous) => ({ ...previous, status: errorMessage(cause) }));
    } finally {
      statusPending.count = Math.max(0, statusPending.count - 1);
      if (currentOwner() && gates.status.isCurrent(request)) setLoading(false);
    }
  }, [currentOwner, enabled, execute, gates, refreshHistory, statusPending]);
  const refresh = useCallback(async () => {
    await Promise.all([refreshStatus(), refreshHistory()]);
  }, [refreshStatus, refreshHistory]);

  useEffect(() => {
    active.current = true;
    setProjection(EMPTY_PROJECTION);
    setProjectionOwner(() => execute);
    setErrors({});
    setLoading(enabled);
    setLoadingRuns(false);
    setLoadingHistory(false);
    pagePending.current = { runs: false, history: false };
    settledReview.current = undefined;
    void refresh();
    const timer = enabled
      ? setInterval(() => {
          if (statusPending.count === 0) void refreshStatus();
        }, 5_000)
      : undefined;
    return () => {
      active.current = false;
      Object.values(gates).forEach((gate) => gate.invalidate());
      if (timer !== undefined) clearInterval(timer);
    };
  }, [enabled, execute, gates, refresh, refreshStatus, statusPending]);

  const loadMore = async (kind: "runs" | "history") => {
    const cursor = projection[kind]?.nextCursor;
    if (!cursor || pagePending.current[kind]) return;
    pagePending.current[kind] = true;
    const gate = kind === "runs" ? gates.runsPage : gates.historyPage;
    const request = gate.begin();
    const errorKey = kind === "runs" ? "runsPage" : "historyPage";
    const setPending = kind === "runs" ? setLoadingRuns : setLoadingHistory;
    setPending(true);
    try {
      const page = await execute({ type: kind === "runs" ? "status" : "history", cursor });
      if (!currentOwner() || !gate.isCurrent(request)) return;
      setErrors((previous) => ({ ...previous, [errorKey]: null }));
      // 尾页返回的 current 可能早于刚收到的轮询；只合并页面，不倒退当前阶段和终态。
      if (kind === "runs" && page.type === "status")
        setProjection((previous) => ({
          ...previous,
          runs: mergeContinuityPage(
            previous.runs,
            { items: page.runs, nextCursor: page.nextCursor },
            runKey,
            "append",
          ),
        }));
      if (kind === "history" && page.type === "history")
        setProjection((previous) => ({
          ...previous,
          history: mergeContinuityPage(
            previous.history,
            { items: page.entries, nextCursor: page.nextCursor },
            historyKey,
            "append",
          ),
        }));
    } catch (cause) {
      if (currentOwner() && gate.isCurrent(request))
        setErrors((previous) => ({ ...previous, [errorKey]: errorMessage(cause) }));
    } finally {
      if (currentOwner() && gate.isCurrent(request)) {
        pagePending.current[kind] = false;
        setPending(false);
      }
    }
  };
  return {
    ...(projectionOwner === execute ? projection : EMPTY_PROJECTION),
    error: Object.values(errors).filter(Boolean).join("\n") || null,
    loading,
    loadingRuns,
    loadingHistory,
    refresh,
    loadMoreRuns: () => loadMore("runs"),
    loadMoreHistory: () => loadMore("history"),
  };
}

/** 目录与正文共用现有受控 MemoryService；关闭自动许可不影响只读查询。 */
export function useMemoryCatalog(
  service: Pick<IMemoryService, "listProjectMemories">,
  enabled: boolean,
) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<ProjectMemoryWorkspaceSummary[]>([]);
  const gate = useMemo(createContinuityRequestGate, [service]);
  const refresh = useCallback(async () => {
    if (!enabled) return null;
    const request = gate.begin();
    setState("loading");
    setError(null);
    try {
      const result = await service.listProjectMemories();
      if (!gate.isCurrent(request)) return null;
      setWorkspaces(result);
      setState("ready");
      return result;
    } catch (cause) {
      if (gate.isCurrent(request)) {
        setError(errorMessage(cause));
        setState("error");
      }
      return null;
    }
  }, [enabled, gate, service]);
  useEffect(() => {
    setWorkspaces([]);
    setError(null);
    setState(enabled ? "loading" : "idle");
    void refresh();
    return () => gate.invalidate();
  }, [enabled, gate, refresh]);
  return { state, error, workspaces, refresh };
}

export function useMemoryFilePreview(workspaceId: string | undefined) {
  const { memoryService } = useServices();
  const [fileName, setFileName] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gate = useMemo(createContinuityRequestGate, [memoryService, workspaceId]);
  const close = useCallback(() => {
    gate.invalidate();
    setFileName(null);
    setContent(null);
    setError(null);
    setLoading(false);
  }, [gate]);
  useEffect(() => {
    close();
    return () => gate.invalidate();
  }, [close, gate]);
  const open = async (name: string) => {
    if (!workspaceId) return;
    const request = gate.begin();
    setFileName(name);
    setContent(null);
    setError(null);
    setLoading(true);
    try {
      const result = await memoryService.readProjectMemoryFile({ workspaceId, fileName: name });
      if (gate.isCurrent(request)) setContent(result.content);
    } catch (cause) {
      if (gate.isCurrent(request)) setError(errorMessage(cause));
    } finally {
      if (gate.isCurrent(request)) setLoading(false);
    }
  };
  return { fileName, content, loading, error, open, close };
}
