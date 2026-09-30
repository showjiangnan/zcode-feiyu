// Modified by ZCode Feiyu contributors (2026).
import { useBackgroundContinuity } from "@/hooks/useBackgroundContinuity.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { SettingsRow } from "./SettingsPageParts.js";

export function BackgroundContinuityStatusRow() {
  const { status, error, stopping, stop, available, canStop } = useBackgroundContinuity();
  const { intl, locale } = useZCodeIntl();
  const t = (key: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `settings.background.${key}` }, values);
  const hidden = status?.hosts.filter((host) => !host.visible) ?? [];
  const state =
    !available || status?.supported === false ? "unsupported" : (status?.state ?? "loading");
  return (
    <>
      <SettingsRow
        label={t("status")}
        controlLayout="wide"
        description={t(state)}
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={
              !canStop ||
              !status?.supported ||
              !hidden.length ||
              stopping ||
              status.state === "stopping"
            }
            onClick={() => {
              void stop();
            }}
          >
            {t(stopping || status?.state === "stopping" ? "stopping" : "stop")}
          </Button>
        }
      />
      <div
        className="min-w-0 space-y-2 px-4 pb-3 text-ui-sm text-foreground-subtle"
        aria-live="polite"
      >
        {status ? (
          <p>
            {t("counts", {
              hosts: hidden.length,
              running: hidden.reduce((sum, host) => sum + host.runningTasks, 0),
              ready: hidden.filter((host) => host.ready).length,
            })}
          </p>
        ) : null}
        <p>{t("quit")}</p>
        {error || status?.error ? (
          <p role="alert" className="break-words text-destructive">
            {error ?? status?.error}
          </p>
        ) : null}
        <section className="space-y-2" aria-label={t("stopHistory")}>
          <h4 className="text-ui-sm font-medium">{t("stopHistory")}</h4>
          <p>{t("stopHistoryScope")}</p>
          {status?.stopHistory === undefined ? (
            <p>{t("historyNotReported")}</p>
          ) : !status.stopHistory.length ? (
            <p>{t("noStops")}</p>
          ) : (
            <ol className="divide-y divide-border">
              {status.stopHistory.map((record) => (
                <li key={record.requestId} className="space-y-1 py-2">
                  <p>
                    {t(`reason.${record.reason}`)} · {t(`outcome.${record.outcome}`)}
                  </p>
                  <p>
                    {t("stopTimes", {
                      start: new Date(record.startedAt).toLocaleString(locale),
                      end: new Date(record.finishedAt).toLocaleString(locale),
                    })}
                  </p>
                  <ul className="space-y-1">
                    {record.targets.map((target) => (
                      <li key={target.windowId} className="break-words">
                        <span>
                          {t("targetResult", {
                            window: target.windowId,
                            status: t(`target.${target.status}`),
                          })}
                        </span>
                        {target.error ? <p className="text-destructive">{target.error}</p> : null}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </>
  );
}
