import { useEffect, useRef } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** Root 中既有单一向导通过 portal 展示；离开页面只收起，不能创建第二个连接 owner。 */
export function SshSettingsSection({
  onMount,
}: {
  onMount?: (element: HTMLElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { intl } = useZCodeIntl();
  useEffect(() => {
    onMount?.(ref.current);
    return () => onMount?.(null);
  }, [onMount]);
  if (!onMount)
    return (
      <Alert>
        <AlertDescription>
          {intl.formatMessage({ id: "remoteServices.desktopOnly" })}
        </AlertDescription>
      </Alert>
    );
  return <div ref={ref} data-testid="settings-ssh-page" className="min-h-120 w-full" />;
}
