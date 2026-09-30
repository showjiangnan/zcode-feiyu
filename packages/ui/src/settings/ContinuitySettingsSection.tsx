// Modified by ZCode Feiyu contributors (2026).
import { useState } from "react";
import {
  DEFAULT_CONTINUITY_POLICY,
  continuityPolicySchema,
  type ContinuityPolicy,
} from "@zcode/shared";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Switch } from "@/components/ui/switch.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { SettingsGroupCard, SettingsRow } from "./SettingsPageParts.js";

export function ContinuitySettingsSection() {
  const { settings, loading, error: settingsError, update } = useSettings();
  const { intl } = useZCodeIntl();
  const policy = settings?.continuityPolicy ?? DEFAULT_CONTINUITY_POLICY;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = (name: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `settings.continuity.${name}` }, values);
  const save = async (next: ContinuityPolicy) => {
    // 首读未完成时 policy 只是显示默认值，不能提交它覆盖已有许可。
    if (busy || loading || !settings) return;
    setBusy(true);
    setError(null);
    try {
      await update({ continuityPolicy: continuityPolicySchema.parse(next) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3" aria-label={t("title")}>
      <h3 className="text-ui-base font-medium">{t("title")}</h3>
      <SettingsGroupCard>
        <SettingsRow
          controlLayout="wide"
          label={t("proactive")}
          description={t("proactiveDescription")}
          control={
            <Switch
              aria-label={t("proactive")}
              checked={policy.proactiveWorkAllowed}
              disabled={busy || loading || !settings}
              onCheckedChange={(allowed) => {
                void save({ ...policy, proactiveWorkAllowed: allowed });
              }}
            />
          }
        />
        <SettingsRow
          controlLayout="wide"
          label={t("scope")}
          description={t("scopeDescription")}
          control={
            <Select
              value={policy.memoryHistoryScope}
              disabled={busy || loading || !settings?.memoryEnabled}
              onValueChange={(scope: ContinuityPolicy["memoryHistoryScope"]) => {
                void save({ ...policy, memoryHistoryScope: scope });
              }}
            >
              <SelectTrigger aria-label={t("scope")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["workspace", "current_session", "none"].map((scope) => (
                  <SelectItem value={scope} key={scope}>
                    {t(`scope.${scope}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroupCard>
      {!settings?.memoryEnabled ? (
        <p className="text-ui-sm text-foreground-subtle">{t("readOnly")}</p>
      ) : null}
      {busy ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {t("saving")}
        </p>
      ) : null}
      {error || settingsError ? (
        <p role="alert" className="break-words text-ui-sm text-destructive">
          {error ??
            (settingsError instanceof Error ? settingsError.message : String(settingsError))}
        </p>
      ) : null}
    </section>
  );
}
