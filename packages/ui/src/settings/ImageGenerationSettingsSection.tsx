// Modified by ZCode Feiyu contributors (2026).
import { LoaderCircle } from "lucide-react";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { SettingsGroupCard, SettingsRow } from "./SettingsPageParts.js";
import { useImageGenerationSettings } from "@/hooks/useImageGenerationSettings.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function ImageGenerationSettingsSection({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath?: string | null;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const state = useImageGenerationSettings(workspacePath, workspaceIdentity);
  const t = (key: string) => intl.formatMessage({ id: `imageGeneration.${key}` });
  const modelOptions = new Map(state.models.map((model) => [model.id, model.name]));
  if (state.config.model.trim())
    modelOptions.set(
      state.config.model,
      modelOptions.get(state.config.model) ?? state.config.model,
    );
  return (
    <div className="space-y-4" data-image-generation-settings="">
      <p className="text-ui-base text-foreground-subtle">{t("description")}</p>
      <SettingsGroupCard>
        <SettingsRow
          label={t("enabled")}
          description={t("enabledDescription")}
          controlLayout="wide"
          control={
            <Switch
              aria-label={t("enabled")}
              checked={state.config.enabled}
              disabled={state.pending}
              onCheckedChange={(enabled) => void state.save({ ...state.config, enabled })}
            />
          }
        />
        <SettingsRow
          label={t("subagents")}
          description={t("subagentsDescription")}
          controlLayout="wide"
          control={
            <Switch
              aria-label={t("subagents")}
              checked={state.config.allowSubagents}
              disabled={state.pending}
              onCheckedChange={(allowSubagents) =>
                void state.save({ ...state.config, allowSubagents })
              }
            />
          }
        />
        <SettingsRow
          label={t("apiUrl")}
          controlLayout="wide"
          control={
            <Input
              aria-label={t("apiUrl")}
              value={state.config.apiUrl}
              disabled={state.pending}
              onChange={(event) => state.setConfig({ ...state.config, apiUrl: event.target.value })}
              placeholder="https://queue.fal.run"
            />
          }
        />
        <SettingsRow
          label={t("apiKey")}
          description={state.hasCredential ? t("keySaved") : t("keyMissing")}
          controlLayout="wide"
          control={
            <Input
              aria-label={t("apiKey")}
              type="password"
              autoComplete="new-password"
              value={state.apiKey}
              disabled={state.pending}
              onChange={(event) => state.setApiKey(event.target.value)}
              placeholder={state.hasCredential ? "••••••••" : ""}
            />
          }
        />
        <SettingsRow
          label={t("model")}
          controlLayout="wide"
          control={
            <Select
              value={state.config.model}
              disabled={state.pending}
              onValueChange={(model) => state.setConfig({ ...state.config, model })}
            >
              <SelectTrigger aria-label={t("model")} className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...modelOptions].map(([id, name]) => (
                  <SelectItem key={id} value={id}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingsRow
          label={t("modelId")}
          description={t("modelDescription")}
          controlLayout="wide"
          control={
            <Input
              aria-label={t("modelId")}
              value={state.config.model}
              disabled={state.pending}
              onChange={(event) => state.setConfig({ ...state.config, model: event.target.value })}
            />
          }
        />
        <SettingsRow
          label={t("editModel")}
          description={t("editModelDescription")}
          controlLayout="wide"
          control={
            <Input
              aria-label={t("editModel")}
              value={state.config.editModel ?? ""}
              disabled={state.pending}
              placeholder="fal-ai/flux-pro/kontext"
              onChange={(event) =>
                state.setConfig({ ...state.config, editModel: event.target.value || undefined })
              }
            />
          }
        />
      </SettingsGroupCard>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={state.pending} onClick={() => void state.save()}>
          {state.pending ? (
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
          ) : null}
          {t("save")}
        </Button>
        <Button
          variant="outline"
          disabled={state.pending}
          onClick={() => void state.refreshModels()}
        >
          {t("refreshModels")}
        </Button>
        <Button variant="outline" disabled={state.pending} onClick={() => void state.validate()}>
          {t("validate")}
        </Button>
        <Button
          variant="outline"
          disabled={state.pending || !state.hasCredential}
          onClick={() => void state.save({ ...state.config, enabled: false }, true)}
        >
          {t("clearKey")}
        </Button>
      </div>
      <p className="text-ui-caption text-foreground-subtle">{t("privacy")}</p>
      {state.error ? (
        <p role="alert" className="text-ui-base text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p role="status" className="text-ui-base text-foreground-subtle">
          {t(state.notice)}
        </p>
      ) : null}
    </div>
  );
}
