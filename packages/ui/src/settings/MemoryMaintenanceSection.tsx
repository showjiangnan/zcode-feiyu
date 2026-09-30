// Modified by ZCode Feiyu contributors (2026).
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceMemoryResult } from "@zcode/shared";
import { DEFAULT_CONTINUITY_POLICY } from "@zcode/shared";
import { useSettings } from "@/hooks/useSettingService.js";
import { useMemoryMaintenance, useWorkspaceMemory } from "@/hooks/useWorkspaceMemory.js";
import {
  createContinuityRequestGate,
  memoryRevertOperation,
} from "@/hooks/continuityProjection.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { MemoryRunHistory, MemoryRevisionDialog } from "./MemoryMaintenanceHistory.js";
import { MemoryMaintenanceStatus } from "./MemoryMaintenanceStatus.js";
import { getPathLeaf } from "@/lib/path.js";
import { SettingsGroupCard, SettingsRow } from "./SettingsPageParts.js";
import { PluginScopeMenu } from "./PluginScopeMenu.js";

type Revision = Extract<WorkspaceMemoryResult, { type: "revision" }>;
type Action = "review" | "cancel" | "revision" | "revert";

export function MemoryMaintenanceSection({
  workspacePaths,
}: {
  workspacePaths: readonly string[];
}) {
  const { intl } = useZCodeIntl();
  const title = intl.formatMessage({ id: "settings.continuity.maintenance" });
  const [selectedPath, setSelectedPath] = useState(workspacePaths[0] ?? "");
  const workspacePath = workspacePaths.includes(selectedPath)
    ? selectedPath
    : (workspacePaths[0] ?? "");
  return (
    <section className="min-w-0 space-y-3" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-ui-base font-medium">{title}</h3>
        <PluginScopeMenu
          includeUser={false}
          selectedScopeKey={workspacePath}
          disabled={!workspacePaths.length}
          workspaceOptions={workspacePaths.map((path) => ({ key: path, label: getPathLeaf(path) }))}
          onScopeKeyChange={setSelectedPath}
          triggerTestId="memory-maintenance-workspace"
        />
      </div>
      {/* 工作区切换销毁旧查询投影；A→B→A 不能重新接收第一次 A 的迟到回包。 */}
      <WorkspaceMaintenance key={workspacePath} workspacePath={workspacePath} />
    </section>
  );
}

function WorkspaceMaintenance({ workspacePath }: { workspacePath: string }) {
  const { intl, locale } = useZCodeIntl();
  const { settings } = useSettings();
  const t = (key: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `settings.continuity.${key}` }, values);
  const date = (value: number) => new Date(value).toLocaleString(locale);
  const { execute, tasks, taskError, model } = useWorkspaceMemory(workspacePath);
  const maintenance = useMemoryMaintenance(execute, Boolean(workspacePath));
  const [sourceSessionId, setSourceSessionId] = useState("");
  const [revision, setRevision] = useState<Revision | null>(null);
  const revisionTrigger = useRef<HTMLButtonElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<Action>>(new Set());
  const [feedback, setFeedback] = useState<{ kind: Action; text: string } | null>(null);
  const pendingRef = useRef(new Set<Action>());
  const revisionGate = useMemo(createContinuityRequestGate, [execute]);
  const owner = useMemo(() => ({ active: true }), [execute]);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  useEffect(() => {
    owner.active = true;
    setRevision(null);
    setSourceSessionId("");
    setError(null);
    setFeedback(null);
    setPending(new Set());
    pendingRef.current = new Set();
    return () => {
      owner.active = false;
      revisionGate.invalidate();
    };
  }, [owner, revisionGate]);
  const run = async (kind: Action, action: (isCurrent: () => boolean) => Promise<void>) => {
    if (pendingRef.current.has(kind)) return;
    const isCurrent = () => owner.active && ownerRef.current === owner;
    pendingRef.current.add(kind);
    setPending(new Set(pendingRef.current));
    setError(null);
    try {
      await action(isCurrent);
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent()) {
        pendingRef.current.delete(kind);
        setPending(new Set(pendingRef.current));
      }
    }
  };
  const current = maintenance.current;
  const reviewing = current?.status === "running";
  const scope =
    settings?.continuityPolicy?.memoryHistoryScope ?? DEFAULT_CONTINUITY_POLICY.memoryHistoryScope;
  const writable = settings?.memoryEnabled === true;
  const selectedSession = tasks.find((task) => task.taskId === sourceSessionId);
  const reviewDisabledReason = !writable
    ? t("readOnly")
    : !workspacePath
      ? t("workspaceRequired")
      : !model
        ? t("modelRequired")
        : scope === "current_session" && !selectedSession
          ? t("selectSession")
          : undefined;
  return (
    <>
      <SettingsGroupCard>
        <SettingsRow
          label={t("maintenanceModel")}
          controlLayout="wide"
          description={
            <span className="break-all">
              {model
                ? `${model.providerId} / ${model.modelId}${model.options?.reasoningLevel ? ` / ${model.options.reasoningLevel}` : ""}`
                : t("modelRequired")}
            </span>
          }
          control={
            <Button
              variant="outline"
              disabled={Boolean(reviewDisabledReason) || pending.has("review") || reviewing}
              title={reviewDisabledReason}
              onClick={() => {
                void run("review", async (isCurrent) => {
                  setFeedback(null);
                  const result = await execute({
                    type: "review",
                    selection: model ?? undefined,
                    ...(scope === "current_session" && selectedSession
                      ? { sourceSessionId: selectedSession.taskId }
                      : {}),
                  });
                  if (!isCurrent()) return;
                  if (result.type === "review")
                    setFeedback({
                      kind: "review",
                      text:
                        result.result.error ??
                        result.result.reason ??
                        t(`status.${result.result.status}`),
                    });
                  await maintenance.refresh();
                });
              }}
            >
              {t(pending.has("review") ? "reviewPending" : "review")}
            </Button>
          }
        />
        <SettingsRow
          label={t("scope")}
          controlLayout="wide"
          description={t(`scope.${scope}`)}
          control={
            scope === "current_session" ? (
              <Select
                value={sourceSessionId}
                onValueChange={setSourceSessionId}
                disabled={!writable || pending.has("review")}
              >
                <SelectTrigger className="min-w-0" aria-label={t("sourceSession")}>
                  <SelectValue placeholder={t("selectSession")} />
                </SelectTrigger>
                <SelectContent>
                  {tasks.map((task) => (
                    <SelectItem key={task.taskId} value={task.taskId}>
                      {task.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null
          }
        />
        <SettingsRow
          label={
            current
              ? t(`status.${current.status}`)
              : t(maintenance.loading ? "loading" : "status.idle")
          }
          controlLayout="wide"
          description={
            current ? t("stageLabel", { stage: t(`stage.${current.stage}`) }) : t("noRuns")
          }
          control={
            <Button
              variant="ghost"
              disabled={
                !reviewing || !current?.reviewId || current.cancelRequested || pending.has("cancel")
              }
              onClick={() => {
                if (current?.reviewId)
                  void run("cancel", async (isCurrent) => {
                    const result = await execute({
                      type: "cancelReview",
                      reviewId: current.reviewId!,
                    });
                    if (!isCurrent()) return;
                    if (result.type === "cancelled")
                      setFeedback({
                        kind: "cancel",
                        text: t(result.accepted ? "stopRequested" : "stopUnavailable"),
                      });
                    await maintenance.refresh();
                  });
              }}
            >
              {t(
                reviewing && (current.cancelRequested || pending.has("cancel"))
                  ? "stopping"
                  : "stop",
              )}
            </Button>
          }
        />
      </SettingsGroupCard>
      <MemoryMaintenanceStatus
        current={current}
        reviewing={reviewing}
        automaticEnabled={writable && Boolean(settings?.memoryReviewEnabled)}
        reviewDisabledReason={reviewDisabledReason}
        thresholdProgress={maintenance.thresholdProgress}
        feedbackText={
          feedback && (feedback.kind !== "cancel" || reviewing) ? feedback.text : undefined
        }
        errorText={error || maintenance.error || taskError || undefined}
      />
      <MemoryRunHistory
        page={maintenance.runs}
        loading={maintenance.loading}
        loadingMore={maintenance.loadingRuns}
        onMore={maintenance.loadMoreRuns}
      />
      <section className="space-y-2" aria-label={t("fileHistory")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-ui-sm font-medium">{t("fileHistory")}</h4>
          <Button
            variant="ghost"
            disabled={!workspacePath}
            onClick={() => {
              void maintenance.refresh();
            }}
          >
            {t("refresh")}
          </Button>
        </div>
        <div className="divide-y divide-border">
          {maintenance.history?.items.map((entry) => (
            <div
              className="flex flex-wrap items-center justify-between gap-2 py-2"
              key={entry.operationId}
            >
              <div className="min-w-0 text-ui-sm">
                <p className="break-all">
                  {getPathLeaf(entry.path)} · {date(entry.createdAt)}
                </p>
                <p className="break-all text-foreground-subtle">
                  {t(`history.${entry.state}`)} · {t("source", { source: entry.sourceSessionId })}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending.has("revision")}
                onClick={(event) => {
                  revisionTrigger.current = event.currentTarget;
                  void run("revision", async (isCurrent) => {
                    const request = revisionGate.begin();
                    const result = await execute({
                      type: "revision",
                      operationId: entry.operationId,
                    });
                    if (
                      isCurrent() &&
                      revisionGate.isCurrent(request) &&
                      result.type === "revision"
                    )
                      setRevision(result);
                  });
                }}
              >
                {t("diff")}
              </Button>
            </div>
          ))}
          {maintenance.history && !maintenance.history.items.length ? (
            <p className="py-2 text-ui-sm text-foreground-subtle">{t("noHistory")}</p>
          ) : null}
        </div>
        {maintenance.history?.nextCursor ? (
          <Button
            variant="ghost"
            disabled={maintenance.loadingHistory}
            aria-label={t("moreHistory")}
            onClick={() => {
              void maintenance.loadMoreHistory();
            }}
          >
            {t("more")}
          </Button>
        ) : null}
      </section>
      <MemoryRevisionDialog
        revision={revision}
        error={error}
        writable={writable}
        reverting={pending.has("revert")}
        triggerRef={revisionTrigger}
        onClose={() => {
          revisionGate.invalidate();
          setRevision(null);
          setError(null);
        }}
        onRevert={() => {
          if (revision)
            void run("revert", async (isCurrent) => {
              await execute(memoryRevertOperation(revision));
              if (!isCurrent()) return;
              setRevision(null);
              await maintenance.refresh();
            });
        }}
      />
    </>
  );
}
