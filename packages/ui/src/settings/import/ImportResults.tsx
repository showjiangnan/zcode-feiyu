// Modified by ZCode Feiyu.
import type { ExternalImportOperation } from "@zcode/shared";
import type { useExternalImport } from "@/hooks/useExternalImport.js";
import { Button } from "@/components/ui/button.js";
export function ImportResults({
  operation,
  controller,
  onClose,
  t,
  reason,
}: {
  operation: ExternalImportOperation;
  controller: ReturnType<typeof useExternalImport>;
  onClose: () => void;
  t: (name: string) => string;
  reason: (value?: string) => string | undefined;
}) {
  return (
    <>
      {operation.results.map((item) => (
        <div key={item.key} className="rounded-lg border border-border p-3 text-ui-sm">
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 break-words font-medium">{item.label}</span>
            <span className="shrink-0 text-foreground-subtle">{t(item.status)}</span>
          </div>
          {item.reason && (
            <p className="mt-1 break-words text-foreground-subtle">{reason(item.reason)}</p>
          )}
          {item.warnings?.map((warning, index) => (
            <p key={index} className="mt-1 break-words text-ui-xs text-foreground-subtle">
              {reason(warning)}
            </p>
          ))}
          {item.targetPath && (
            <>
              <p className="mt-1 break-all text-ui-xs text-foreground-subtle">{item.targetPath}</p>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void controller.revealResult(item.targetPath!)}
              >
                {t("open")}
              </Button>
            </>
          )}
          {item.workspacePath && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                controller.openResult(item);
                onClose();
              }}
            >
              {t("open")}
            </Button>
          )}
        </div>
      ))}
    </>
  );
}
