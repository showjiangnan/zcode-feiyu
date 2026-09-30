// Modified by ZCode Feiyu contributors (2026).
import type { WorkspaceMemoryResult } from "@zcode/shared";
import { formatMemoryRunObservation } from "@/hooks/continuityProjection.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type MemoryStatus = Extract<WorkspaceMemoryResult, { type: "status" }>;

/** 纯展示：运行事实与门槛进度来自维护 hook，这里不查询也不保存第二份状态。 */
export function MemoryMaintenanceStatus({
  current,
  reviewing,
  automaticEnabled,
  reviewDisabledReason,
  thresholdProgress,
  feedbackText,
  errorText,
}: {
  current: MemoryStatus["current"];
  reviewing: boolean;
  automaticEnabled: boolean;
  reviewDisabledReason?: string;
  thresholdProgress: MemoryStatus["thresholdProgress"] | null;
  feedbackText?: string;
  errorText?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const t = (key: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `settings.continuity.${key}` }, values);
  const date = (value: number) => new Date(value).toLocaleString(locale);
  const observation = formatMemoryRunObservation(current ?? {}, locale, t);
  const count = (value: number | undefined) =>
    value === undefined ? t("notReported") : value.toLocaleString(locale);
  return (
    <div
      className="min-w-0 space-y-2 text-ui-sm text-foreground-subtle"
      role="status"
      aria-live="polite"
      data-testid="memory-maintenance-status"
    >
      {reviewDisabledReason ? <p>{reviewDisabledReason}</p> : null}
      <p>{t(automaticEnabled ? "automaticEnabled" : "automaticDisabled")}</p>
      <p>{t("usageDescription")}</p>
      {/* 开启但未达门槛时说明进度：否则用户只看到「开着却什么都不发生」（复审 GAP-05）。 */}
      {automaticEnabled && !reviewing && thresholdProgress ? (
        <p data-testid="memory-review-threshold-progress">
          {t("thresholdProgress", {
            progressed: thresholdProgress.progressedSessions,
            required: thresholdProgress.requiredSessions,
          })}
        </p>
      ) : null}
      {current ? (
        <>
          <p>{t("observedScope", { scope: observation.scope, count: observation.sessionCount })}</p>
          <p>
            {t("tokenUsage", {
              tokens: current.totalTokens.toLocaleString(locale),
              usage: observation.usage,
            })}
          </p>
          <p>
            {t("lastSuccess", {
              time:
                current.lastSuccessAt === undefined
                  ? t("notReported")
                  : date(current.lastSuccessAt),
            })}
          </p>
          <p>{t("failureCount", { count: count(current.failureCount) })}</p>
          {current.cancelRequested && reviewing ? <p>{t("stopRequested")}</p> : null}
          {current.automaticRetryExhausted ? (
            <p className="text-warning">{t("retryExhausted")}</p>
          ) : automaticEnabled && current.status === "failed" && current.nextRetryAt ? (
            <p>
              {t("nextRetry")}: {date(current.nextRetryAt)}
            </p>
          ) : null}
          <p>{t("changedFiles", { count: current.changedFiles.length })}</p>
          {current.changedFiles.length ? (
            <ul className="space-y-1 font-mono">
              {current.changedFiles.map((file) => (
                <li className="break-all" key={file}>
                  {file}
                </li>
              ))}
            </ul>
          ) : null}
          {current.error ? (
            <p role="alert" className="break-words text-destructive">
              {current.error}
            </p>
          ) : null}
        </>
      ) : null}
      {feedbackText ? <p>{feedbackText}</p> : null}
      {errorText ? (
        <p role="alert" className="break-words text-destructive">
          {errorText}
        </p>
      ) : null}
    </div>
  );
}
