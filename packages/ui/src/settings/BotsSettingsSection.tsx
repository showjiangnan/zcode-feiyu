import { BotsDialog } from "@/BotsDialog.js";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function BotsSettingsSection({
  workspacePath,
  workspaceIdentity,
  available,
}: {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  available: boolean;
}) {
  const { intl } = useZCodeIntl();
  if (!available)
    return (
      <Alert>
        <AlertDescription>
          {intl.formatMessage({ id: "remoteServices.desktopOnly" })}
        </AlertDescription>
      </Alert>
    );
  return (
    <BotsDialog
      open
      onOpenChange={() => {}}
      inline
      workspacePath={workspacePath ?? ""}
      workspaceIdentity={workspaceIdentity}
    />
  );
}
