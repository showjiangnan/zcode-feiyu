// Modified by ZCode Feiyu.
import { completeNewModelSelection } from "@zcode/provider";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { ThoughtLevelSlider } from "@/chat-input-toolbar/ThoughtLevelSlider.js";
import { Switch } from "@/components/ui/switch.js";
import { useSuggestedPromptSettings } from "@/hooks/useSuggestedPromptSettings.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { SettingsGroupCard, SettingsRow } from "./SettingsPageParts.js";

const unlocked = () => false;

export function SuggestedPromptSettingsSection() {
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `suggestedPrompt.${key}` });
  const { config, view, valid, pending, error, save } = useSuggestedPromptSettings();
  const selection = config.modelSelection;
  const groups = view ? buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, view) : [];
  const option =
    view && selection
      ? resolveModelThoughtOption({
          modelSelectionView: view,
          ...selection,
          currentValue: selection.options?.reasoningLevel,
        })
      : null;
  return (
    <div className="space-y-4" data-testid="suggested-prompt-settings">
      <p className="text-ui-base text-foreground-subtle">{t("description")}</p>
      <SettingsGroupCard>
        <SettingsRow
          label={t("enabled")}
          description={t("globalDescription")}
          controlLayout="wide"
          control={
            <Switch
              aria-label={t("enabled")}
              checked={config.enabled}
              disabled={pending}
              onCheckedChange={(enabled) => void save({ ...config, enabled })}
            />
          }
        />
        <SettingsRow
          label={t("model")}
          description={t("modelDescription")}
          controlLayout="wide"
          control={
            <ModelConfigSelect
              modelGroups={groups}
              normalizedValue={
                selection ? encodeCustomModelValue(selection.providerId, selection.modelId) : ""
              }
              triggerLabel={
                selection ? `${selection.providerId} / ${selection.modelId}` : t("selectModel")
              }
              showManageModelsAction={false}
              lockReasonMessage=""
              isItemLocked={unlocked}
              disabled={pending || !view}
              triggerClassName="max-w-full"
              triggerLabelClassName="truncate"
              footerContent={
                option && selection ? (
                  <ThoughtLevelSlider
                    option={option}
                    provider={ZCODE_AGENT_PROVIDER}
                    disabled={pending}
                    onValueChange={(reasoningLevel) =>
                      void save({
                        ...config,
                        modelSelection: {
                          ...selection,
                          options: { ...selection.options, reasoningLevel },
                        },
                      })
                    }
                  />
                ) : undefined
              }
              onValueChange={(value) => {
                const decoded = decodeCustomModelValue(value);
                if (!view || !decoded?.modelName) return;
                const modelSelection = completeNewModelSelection(view, {
                  providerId: decoded.providerId,
                  modelId: decoded.modelName,
                });
                if (modelSelection) void save({ ...config, modelSelection });
              }}
            />
          }
        />
      </SettingsGroupCard>
      {selection && !valid ? (
        <p role="status" className="text-ui-base text-warning">
          {t("modelUnavailable")}
        </p>
      ) : null}
      {!selection ? (
        <p className="text-ui-base text-foreground-subtle">{t("selectModel")}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-ui-base text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
