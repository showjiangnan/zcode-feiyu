// Modified by ZCode Feiyu contributors (2026).
import type { MemoryReviewRun, WorkspaceMemoryResult } from "@zcode/shared";
import type { RefObject } from "react";
import { type ContinuityPage, formatMemoryRunObservation } from "@/hooks/continuityProjection.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog.js";
import { EditInlineDiffContent } from "@/ToolCallBlocks/renderers/EditInlineDiffContent.js";
import { buildUnifiedDiff } from "@/lib/codeViewer.js";
import { getPathLeaf } from "@/lib/path.js";

/** 纯展示：页面/运行事实来自维护 hook，不查询或创建第二份历史状态。 */
export function MemoryRunHistory({
  page,
  loading,
  loadingMore,
  onMore,
}: {
  page: ContinuityPage<MemoryReviewRun> | null;
  loading: boolean;
  loadingMore: boolean;
  onMore: () => Promise<void>;
}) {
  const { intl, locale } = useZCodeIntl();
  const t = (key: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `settings.continuity.${key}` }, values);
  const date = (value: number) => new Date(value).toLocaleString(locale);
  return (
    <section className="space-y-2" aria-label={t("runHistory")}>
      <h4 className="text-ui-sm font-medium">{t("runHistory")}</h4>
      <div className="divide-y divide-border">
        {page?.items.map((item) => {
          const observed = formatMemoryRunObservation(item, locale, t);
          return (
            <div className="space-y-1 py-2 text-ui-sm" key={item.reviewId}>
              <p>
                {date(item.startedAt)} · {t(`status.${item.status}`)} ·{" "}
                {t(`trigger.${item.trigger}`)}
              </p>
              <p className="text-foreground-subtle">
                {t("observedScope", { scope: observed.scope, count: observed.sessionCount })}
              </p>
              <p className="text-foreground-subtle">
                {t("tokenUsage", {
                  tokens: item.totalTokens.toLocaleString(locale),
                  usage: observed.usage,
                })}
              </p>
              {item.finishedAt !== null ? (
                <p className="text-foreground-subtle">
                  {t("finishedAt", { time: date(item.finishedAt) })}
                </p>
              ) : null}
              <p className="text-foreground-subtle">
                {t("stageLabel", {
                  stage: item.stage ? t(`stage.${item.stage}`) : t("notReported"),
                })}
              </p>
              <p className="text-foreground-subtle">
                {t("changedFiles", { count: item.changedFiles.length })}
              </p>
              {item.changedFiles.map((file) => (
                <p className="break-all font-mono text-foreground-subtle" key={file}>
                  {file}
                </p>
              ))}
              {item.error ? (
                <p role="alert" className="break-words text-destructive">
                  {item.error}
                </p>
              ) : null}
            </div>
          );
        })}
        {!loading && !page?.items.length ? (
          <p className="py-2 text-ui-sm text-foreground-subtle">{t("noRuns")}</p>
        ) : null}
      </div>
      {page?.nextCursor ? (
        <Button
          variant="ghost"
          disabled={loadingMore}
          aria-label={t("moreRuns")}
          onClick={() => {
            void onMore();
          }}
        >
          {t("more")}
        </Button>
      ) : null}
    </section>
  );
}

export function MemoryRevisionDialog({
  revision,
  error,
  writable,
  reverting,
  triggerRef,
  onClose,
  onRevert,
}: {
  revision: Extract<WorkspaceMemoryResult, { type: "revision" }> | null;
  error: string | null;
  writable: boolean;
  reverting: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onRevert: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const theme = useZCodeStore((state) => state.theme);
  const t = (key: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `settings.continuity.${key}` }, values);
  const patch = revision
    ? buildUnifiedDiff(
        revision.entry.before ?? "",
        revision.entry.after ?? "",
        getPathLeaf(revision.entry.path),
      )
    : null;
  return (
    <Dialog
      open={revision !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          // 列表中的多个入口共用受控 Dialog，默认空 triggerRef 会丢失键盘位置。
          event.preventDefault();
          if (triggerRef.current?.isConnected) triggerRef.current.focus();
        }}
        className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>
            {t("diff")}
            {revision ? ` · ${getPathLeaf(revision.entry.path)}` : ""}
          </DialogTitle>
        </DialogHeader>
        {revision ? (
          <>
            <div className="space-y-1 break-all text-ui-sm text-foreground-subtle">
              <p>
                {t("source", { source: revision.entry.sourceSessionId })} ·{" "}
                {new Date(revision.entry.createdAt).toLocaleString(locale)}
              </p>
              <p>
                {t("beforeRevision")}:{" "}
                <span className="font-mono">{revision.entry.beforeHash ?? t("fileAbsent")}</span>
              </p>
              <p>
                {t("afterRevision")}:{" "}
                <span className="font-mono">{revision.entry.afterHash ?? t("fileAbsent")}</span>
              </p>
              <p>
                {t("currentRevision")}:{" "}
                <span className="font-mono">{revision.currentHash ?? t("fileAbsent")}</span>
              </p>
            </div>
            {patch ? (
              <EditInlineDiffContent
                theme={theme}
                preview={{
                  type: "patch",
                  title: getPathLeaf(revision.entry.path),
                  path: revision.entry.path,
                  patch,
                }}
              />
            ) : (
              <p className="text-ui-sm text-foreground-subtle">{t("noChanges")}</p>
            )}
          </>
        ) : null}
        <p className="text-ui-sm text-foreground-subtle">{t("revertDescription")}</p>
        {!writable ? <p className="text-ui-sm text-foreground-subtle">{t("readOnly")}</p> : null}
        {error ? (
          <p role="alert" className="break-words text-ui-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!writable || reverting || revision?.entry.state !== "committed"}
            onClick={onRevert}
          >
            {t("revert")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
