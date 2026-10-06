import { useEffect, useState } from "react";
import type { RcsConfig } from "@zcode/shared";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { SettingsGroupCard, SettingsRow } from "./SettingsPageParts.js";
import { useRcsSettings } from "@/hooks/useRcsSettings.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function RcsSettingsSection() {
  const model = useRcsSettings();
  const platform = usePlatform();
  const { intl, locale } = useZCodeIntl();
  const text = (id: string) => intl.formatMessage({ id: `remoteServices.${id}` });
  const [draft, setDraft] = useState<RcsConfig | null>(null);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  useEffect(() => {
    if (model.settings) {
      const { enabled, endpoint, deviceName, allowedWorkspaces } = model.settings;
      setDraft({ enabled, endpoint, deviceName, allowedWorkspaces });
      setKey("");
      setClearKey(false);
    }
  }, [model.settings]);
  if (!model.service)
    return (
      <Alert>
        <AlertDescription>{text("desktopOnly")}</AlertDescription>
      </Alert>
    );
  if (!draft || !model.settings)
    return (
      <Alert>
        <AlertDescription>
          {model.error ?? intl.formatMessage({ id: "common.loading" })}
        </AlertDescription>
      </Alert>
    );
  const change = (patch: Partial<RcsConfig>) => {
    setDraft({ ...draft, ...patch });
    setValidation(null);
  };
  const hasKey = (!clearKey && model.settings.hasKey) || key.length >= 32;
  const ready = Boolean(draft.endpoint.trim() && hasKey && draft.allowedWorkspaces.length);
  const toggleWorkspace = (workspaceKey: string) =>
    change({
      allowedWorkspaces: draft.allowedWorkspaces.includes(workspaceKey)
        ? draft.allowedWorkspaces.filter((item) => item !== workspaceKey)
        : [...draft.allowedWorkspaces, workspaceKey],
    });
  return (
    <div className="space-y-4" data-testid="settings-rcs-page">
      <SettingsGroupCard>
        <SettingsRow
          label={text("rcs.enabled")}
          description={text("rcs.description")}
          control={
            <Switch
              aria-label={text("rcs.enabled")}
              checked={draft.enabled}
              disabled={model.busy || (!ready && !draft.enabled)}
              onCheckedChange={(enabled) => change({ enabled })}
            />
          }
        />
        <SettingsRow
          label={text("rcs.status")}
          control={
            <span className="text-ui-base text-foreground-subtle" data-testid="rcs-status">
              {text(`rcs.state.${model.status.state}`)}
            </span>
          }
        />
      </SettingsGroupCard>
      <SettingsGroupCard>
        <SettingsRow
          label={text("rcs.endpoint")}
          description={text("rcs.endpointHint")}
          control={
            <Input
              aria-label={text("rcs.endpoint")}
              className="w-full sm:w-80"
              value={draft.endpoint}
              placeholder="https://"
              autoComplete="off"
              onChange={(event) => change({ endpoint: event.target.value })}
            />
          }
        />
        <SettingsRow
          label={text("rcs.key")}
          description={text("rcs.keyHint")}
          control={
            <div className="flex w-full items-center gap-2 sm:w-80">
              <Input
                aria-label={text("rcs.key")}
                type="password"
                autoComplete="new-password"
                value={key}
                placeholder={text(
                  model.settings.hasKey && !clearKey ? "rcs.keySaved" : "rcs.keyMissing",
                )}
                onChange={(event) => {
                  setKey(event.target.value);
                  setClearKey(false);
                  setValidation(null);
                }}
              />
              <Button
                variant="ghost"
                disabled={model.busy || !model.settings.hasKey}
                onClick={() => {
                  setKey("");
                  setClearKey(true);
                  change({ enabled: false });
                }}
              >
                {text("rcs.clearKey")}
              </Button>
            </div>
          }
        />
        <SettingsRow
          label={text("rcs.deviceName")}
          control={
            <Input
              aria-label={text("rcs.deviceName")}
              className="w-full sm:w-80"
              maxLength={80}
              value={draft.deviceName}
              onChange={(event) => change({ deviceName: event.target.value })}
            />
          }
        />
      </SettingsGroupCard>
      <SettingsGroupCard>
        <SettingsRow label={text("rcs.scope")} description={text("rcs.scopeHint")} control={null} />
        {model.hosts.flatMap((host) =>
          host.workspaces.map((workspace) => {
            const workspaceKey = workspace.workspaceIdentity?.trim() || workspace.workspacePath;
            return (
              <SettingsRow
                key={`${host.id}:${workspace.handle}`}
                label={workspace.name}
                description={workspace.workspacePath}
                control={
                  <Checkbox
                    aria-label={`${text("rcs.allow")} ${workspace.name}`}
                    checked={draft.allowedWorkspaces.includes(workspaceKey)}
                    disabled={model.busy}
                    onCheckedChange={() => toggleWorkspace(workspaceKey)}
                  />
                }
              />
            );
          }),
        )}
        {draft.allowedWorkspaces
          .filter(
            (workspaceKey) =>
              !model.hosts.some((host) =>
                host.workspaces.some(
                  (w) => (w.workspaceIdentity?.trim() || w.workspacePath) === workspaceKey,
                ),
              ),
          )
          .map((workspaceKey) => (
            <SettingsRow
              key={workspaceKey}
              label={workspaceKey}
              description={text("rcs.offlineScope")}
              control={
                <Checkbox
                  aria-label={workspaceKey}
                  checked
                  disabled={model.busy}
                  onCheckedChange={() => toggleWorkspace(workspaceKey)}
                />
              }
            />
          ))}
      </SettingsGroupCard>
      {model.error || model.status.error ? (
        <Alert variant="destructive">
          <AlertDescription>{model.error ?? model.status.error}</AlertDescription>
        </Alert>
      ) : null}
      {validation ? (
        <Alert>
          <AlertDescription>{validation}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={model.busy || !draft.deviceName.trim() || (draft.enabled && !ready)}
          onClick={() => {
            void model.save({
              ...draft,
              expectedRevision: model.settings!.revision,
              ...(key ? { key } : {}),
              ...(clearKey ? { clearKey: true } : {}),
            });
          }}
        >
          {text("rcs.save")}
        </Button>
        <Button
          variant="outline"
          disabled={model.busy || !draft.endpoint || !hasKey}
          onClick={() => {
            void model.run(async () => {
              await model.service!.validate({ endpoint: draft.endpoint, ...(key ? { key } : {}) });
              setValidation(text("rcs.validated"));
            });
          }}
        >
          {text("rcs.validate")}
        </Button>
        <Button
          variant="outline"
          disabled={model.busy || !model.settings.enabled}
          onClick={() => {
            void model.run(() => model.service!.reconnect());
          }}
        >
          {text("rcs.reconnect")}
        </Button>
      </div>
      <SettingsGroupCard>
        <SettingsRow
          label={text("rcs.web")}
          description={text("rcs.webHint")}
          control={
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={!model.settings.endpoint}
                onClick={() => {
                  if (model.settings?.endpoint) platform.openExternal(model.settings.endpoint);
                }}
              >
                {text("rcs.openWeb")}
              </Button>
              <Button
                variant="outline"
                disabled={!model.settings.endpoint}
                onClick={() => {
                  void model.run(() => navigator.clipboard.writeText(model.settings!.endpoint));
                }}
              >
                {text("rcs.copyWeb")}
              </Button>
            </div>
          }
        />
        <SettingsRow
          label={text("rcs.clients")}
          description={text("rcs.clientsHint")}
          control={null}
        />
        {model.clients.map((client) => (
          <SettingsRow
            key={client.id}
            label={client.name || client.id.slice(0, 8)}
            description={new Date(client.createdAt * 1000).toLocaleString(locale)}
            control={
              <Button
                variant="outline"
                disabled={model.busy}
                onClick={() => {
                  void model.run(() => model.service!.revokeClient(client.id));
                }}
              >
                {text("rcs.revoke")}
              </Button>
            }
          />
        ))}
        <SettingsRow
          label={text("rcs.docs")}
          control={
            <Button
              variant="link"
              onClick={() => platform.openExternal("https://github.com/showjiangnan/zcode-rcs")}
            >
              {text("rcs.docsAction")}
            </Button>
          }
        />
      </SettingsGroupCard>
    </div>
  );
}
