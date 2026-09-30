// Modified by ZCode Feiyu contributors (2026).
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { type IMemoryService } from "@zcode/services";
import { TID_SETTINGS_MEMORY_SWITCH } from "@zcode/shared";
import type {
  ZCodeSessionReadProjectMemoryReviewResult,
  ZCodeSessionReviewProjectMemoryResult,
} from "@zcode/shared";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { Switch } from "@/components/ui/switch.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MemorySettingsViewer } from "@/settings/MemorySettingsViewer.js";
import { useMemoryCatalog } from "@/hooks/useWorkspaceMemory.js";
import {
  buildMemoryWorkspaceDisplayNameMap,
  normalizeMemoryWorkspaceDisplayName,
} from "@/hooks/continuityProjection.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { MemoryMaintenanceSection } from "./MemoryMaintenanceSection.js";
import { ContinuitySettingsSection } from "./ContinuitySettingsSection.js";

type MemoryCatalogService = Pick<IMemoryService, "listProjectMemories">;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MemorySettingsSection({
  memoryEnabled,
  memoryExtractionEnabled,
  memoryReviewEnabled,
  memoryService,
  onMemoryEnabledChange,
  onMemoryExtractionEnabledChange,
  onMemoryReviewEnabledChange,
  onReviewNow,
  onReadReviewStatus,
  onCancelReview,
  projectMemoryViewerAvailable,
  workspaceDisplayNames = [],
  maintenanceWorkspacePaths,
}: {
  memoryEnabled: boolean;
  memoryExtractionEnabled: boolean;
  memoryReviewEnabled: boolean;
  memoryService: MemoryCatalogService;
  onMemoryEnabledChange: (enabled: boolean) => Promise<void>;
  onMemoryExtractionEnabledChange: (enabled: boolean) => Promise<void>;
  onMemoryReviewEnabledChange: (enabled: boolean) => Promise<void>;
  onReviewNow?: () => Promise<ZCodeSessionReviewProjectMemoryResult>;
  onReadReviewStatus?: () => Promise<ZCodeSessionReadProjectMemoryReviewResult>;
  onCancelReview?: (reviewId: string) => Promise<{ accepted: boolean }>;
  projectMemoryViewerAvailable: boolean;
  workspaceDisplayNames?: readonly string[];
  maintenanceWorkspacePaths?: readonly string[];
}) {
  const { intl } = useZCodeIntl();
  const {
    state: catalogState,
    error: catalogError,
    workspaces,
    refresh: refreshCatalog,
  } = useMemoryCatalog(memoryService, projectMemoryViewerAvailable);
  const disabledDescriptionId = useId();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reviewReadError, setReviewReadError] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [reviewRunning, setReviewRunning] = useState(false);
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [reviewRecord, setReviewRecord] = useState<ZCodeSessionReadProjectMemoryReviewResult>(null);

  useEffect(() => {
    if (!onReadReviewStatus) {
      setReviewRecord(null);
      return;
    }
    let active = true;
    const refresh = async () => {
      try {
        const result = await onReadReviewStatus();
        if (active) {
          setReviewRecord(result);
          setReviewReadError(null);
        }
      } catch (cause) {
        // 一次只读查询失败不能抹掉真实终态；保留上次事实并单独提示读取失败。
        if (active) setReviewReadError(getErrorMessage(cause));
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [onReadReviewStatus]);

  const savePermission = async (action: () => Promise<void>) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await action();
    } catch (cause) {
      setSaveError(getErrorMessage(cause));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const displayWorkspaces = useMemo(() => {
    const displayNameBySlug = buildMemoryWorkspaceDisplayNameMap(workspaceDisplayNames);
    const orderBySlug = new Map<string, number>();
    for (const [index, name] of workspaceDisplayNames.entries()) {
      const slug = normalizeMemoryWorkspaceDisplayName(name);
      if (!orderBySlug.has(slug)) orderBySlug.set(slug, index);
    }
    return workspaces
      .map((workspace, catalogIndex) => {
        const slug = normalizeMemoryWorkspaceDisplayName(workspace.label);
        return {
          catalogIndex,
          order: orderBySlug.get(slug) ?? Number.POSITIVE_INFINITY,
          workspace: {
            ...workspace,
            label: displayNameBySlug.get(slug) ?? workspace.label,
          },
        };
      })
      .sort((left, right) => left.order - right.order || left.catalogIndex - right.catalogIndex)
      .map(({ workspace }) => workspace);
  }, [workspaceDisplayNames, workspaces]);
  const selectedWorkspace = useMemo(
    () => displayWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId),
    [displayWorkspaces, selectedWorkspaceId],
  );

  useEffect(() => {
    const firstWorkspace = displayWorkspaces[0];
    if (!firstWorkspace) {
      setSelectedWorkspaceId(null);
      return;
    }
    if (
      !selectedWorkspaceId ||
      !displayWorkspaces.some((workspace) => workspace.id === selectedWorkspaceId)
    ) {
      setSelectedWorkspaceId(firstWorkspace.id);
    }
  }, [displayWorkspaces, selectedWorkspaceId]);

  const handleRefresh = useCallback(async () => {
    await runUserActionAsync({
      input: { featureId: "settings.memory", action: "refresh_memory", trigger: "button" },
      operation: refreshCatalog,
      completed: { resultSource: "platform_result" },
      failureStage: "catalog_refresh",
    });
  }, [refreshCatalog]);

  const handleReviewNow = useCallback(async () => {
    if (!onReviewNow || reviewRunning) return;
    setReviewRunning(true);
    setReviewMessage(null);
    try {
      const result = await runUserActionAsync({
        input: { featureId: "settings.memory", action: "review_now", trigger: "button" },
        operation: onReviewNow,
        completed: { resultSource: "platform_result" },
        failureStage: "review",
      });
      setReviewMessage(
        result.status === "completed"
          ? intl.formatMessage(
              { id: "settings.memory.reviewCompleted" },
              {
                count: result.changedFiles?.length ?? 0,
              },
            )
          : (result.reason ?? result.error ?? result.status),
      );
      await refreshCatalog();
    } catch (error) {
      setReviewMessage(getErrorMessage(error));
    } finally {
      setReviewRunning(false);
    }
  }, [intl, onReviewNow, refreshCatalog, reviewRunning]);

  const handleCancelReview = useCallback(async () => {
    if (!onCancelReview || !reviewRecord?.reviewId) return;
    try {
      const result = await runUserActionAsync({
        input: { featureId: "settings.memory", action: "cancel_review", trigger: "button" },
        operation: () => onCancelReview(reviewRecord.reviewId!),
        completed: { resultSource: "platform_result" },
        failureStage: "review_cancel",
      });
      setReviewMessage(
        intl.formatMessage({
          id: result.accepted
            ? "settings.memory.reviewCancelRequested"
            : "settings.memory.reviewCancelUnavailable",
        }),
      );
    } catch (error) {
      setReviewMessage(getErrorMessage(error));
    }
  }, [intl, onCancelReview, reviewRecord?.reviewId]);

  const reviewStatus =
    reviewRecord?.status === "running"
      ? intl.formatMessage(
          { id: "settings.memory.reviewProgress" },
          {
            stage: intl.formatMessage({ id: `settings.memory.reviewStage.${reviewRecord.stage}` }),
          },
        )
      : reviewRecord?.status === "completed"
        ? intl.formatMessage(
            { id: "settings.memory.reviewLastCompleted" },
            {
              count: reviewRecord.changedFiles.length,
              tokens: reviewRecord.totalTokens,
            },
          )
        : reviewRecord?.status === "cancelled"
          ? intl.formatMessage({ id: "settings.memory.reviewCancelled" })
          : reviewRecord?.status === "failed"
            ? `${intl.formatMessage({ id: "settings.memory.reviewLastFailed" })}: ${reviewRecord.error ?? intl.formatMessage({ id: "settings.continuity.status.failed" })}`
            : null;
  const visibleReviewMessage =
    reviewRecord?.status === "running" && reviewRecord.cancelRequested
      ? intl.formatMessage({ id: "settings.memory.reviewCancelRequested" })
      : reviewRecord?.status === "completed" ||
          reviewRecord?.status === "failed" ||
          reviewRecord?.status === "cancelled"
        ? reviewStatus
        : (reviewMessage ?? reviewStatus);

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          controlLayout="wide"
          label={intl.formatMessage({
            id: "settings.memory.workspaceMemory",
          })}
          description={intl.formatMessage({
            id: "settings.memoryDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.memory.workspaceMemory",
              })}
              checked={memoryEnabled}
              disabled={saving}
              aria-describedby={!memoryEnabled ? disabledDescriptionId : undefined}
              data-testid={TID_SETTINGS_MEMORY_SWITCH}
              onCheckedChange={(checked) => {
                void savePermission(() => onMemoryEnabledChange(checked));
              }}
            />
          }
        />
        <SettingsRow
          controlLayout="wide"
          label={intl.formatMessage({ id: "settings.memory.autoExtraction" })}
          description={intl.formatMessage({ id: "settings.memory.autoExtractionDescription" })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.memory.autoExtraction" })}
              checked={memoryEnabled && memoryExtractionEnabled}
              disabled={!memoryEnabled || saving}
              aria-describedby={!memoryEnabled ? disabledDescriptionId : undefined}
              onCheckedChange={(checked) => {
                void savePermission(() => onMemoryExtractionEnabledChange(checked));
              }}
            />
          }
        />
        <SettingsRow
          controlLayout="wide"
          label={intl.formatMessage({ id: "settings.memory.autoReview" })}
          description={intl.formatMessage({ id: "settings.memory.autoReviewDescription" })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.memory.autoReview" })}
              checked={memoryEnabled && memoryReviewEnabled}
              disabled={!memoryEnabled || saving}
              aria-describedby={!memoryEnabled ? disabledDescriptionId : undefined}
              onCheckedChange={(checked) => {
                void savePermission(() => onMemoryReviewEnabledChange(checked));
              }}
            />
          }
        />
        {maintenanceWorkspacePaths === undefined ? (
          <SettingsRow
            controlLayout="wide"
            label={intl.formatMessage({ id: "settings.memory.reviewNow" })}
            description={intl.formatMessage({ id: "settings.memory.reviewNowDescription" })}
            control={
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!memoryEnabled || !onReviewNow || reviewRunning}
                  onClick={() => {
                    void handleReviewNow();
                  }}
                >
                  {intl.formatMessage({
                    id: reviewRunning
                      ? "settings.memory.reviewRunning"
                      : "settings.memory.reviewNow",
                  })}
                </Button>
                {reviewRecord?.status === "running" && onCancelReview && reviewRecord.reviewId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={reviewRecord.cancelRequested}
                    onClick={() => {
                      void handleCancelReview();
                    }}
                  >
                    {intl.formatMessage({ id: "settings.memory.reviewCancel" })}
                  </Button>
                ) : null}
              </div>
            }
          />
        ) : null}
      </SettingsGroupCard>
      {!memoryEnabled ? (
        <p id={disabledDescriptionId} className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.continuity.readOnly" })}
        </p>
      ) : null}
      {saving ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.memory.savingPermissions" })}
        </p>
      ) : null}
      {saveError ? (
        <p role="alert" className="break-words text-ui-sm text-destructive">
          {saveError}
        </p>
      ) : null}
      {maintenanceWorkspacePaths === undefined && visibleReviewMessage ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {visibleReviewMessage}
        </p>
      ) : null}
      {reviewReadError ? (
        <p role="alert" className="break-words text-ui-sm text-destructive">
          {reviewReadError}
        </p>
      ) : null}

      {maintenanceWorkspacePaths ? (
        <>
          <ContinuitySettingsSection />
          <MemoryMaintenanceSection workspacePaths={maintenanceWorkspacePaths} />
        </>
      ) : null}

      {!projectMemoryViewerAvailable ? (
        <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.memory.viewer.localOnly" })}
        </div>
      ) : (
        <MemorySettingsViewer
          catalogError={catalogError}
          catalogState={catalogState}
          selectedWorkspace={selectedWorkspace}
          workspaces={displayWorkspaces}
          onRefresh={handleRefresh}
          onScopeKeyChange={(workspaceId) =>
            runUserAction({
              input: {
                featureId: "settings.memory",
                action: "change_memory_scope",
                trigger: "select",
              },
              operation: () => setSelectedWorkspaceId(workspaceId),
              completed: { resultSource: "local_commit" },
              failureStage: "local_commit",
            })
          }
        />
      )}
    </div>
  );
}
