// Modified by ZCode Feiyu.
import { useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import "./suggestedPrompt.css";

export function SuggestedPromptToggle({
  enabled,
  available,
  disabled,
  phase,
  onChange,
}: {
  enabled: boolean;
  available: boolean;
  disabled?: boolean;
  phase?: string;
  onChange: (enabled: boolean) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const confirm = useConfirmDialog();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const t = (key: string) => intl.formatMessage({ id: `suggestedPrompt.${key}` });
  const label = enabled ? t("disableSession") : t("enableSession");
  return (
    <ControlHintTooltip
      title={
        error ??
        (!available
          ? t("modelUnavailable")
          : phase === "failed"
            ? t("failed")
            : phase === "generating"
              ? t("generating")
              : label)
      }
    >
      <Button
        type="button"
        size="sm"
        variant="ghost"
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        data-testid="suggested-prompt-toggle"
        data-enabled={enabled ? "true" : "false"}
        className={`suggested-prompt-toggle relative h-7 w-7 shrink-0 rounded-lg p-0 ${enabled ? "suggested-prompt-toggle-on" : ""}`}
        disabled={disabled || pending || (!available && !enabled)}
        onClick={async () => {
          if (pendingRef.current) return;
          pendingRef.current = true;
          setPending(true);
          setError(null);
          try {
            if (
              !enabled &&
              !(await confirm({
                title: t("confirmTitle"),
                description: t("confirmDescription"),
                confirmLabel: t("confirmEnable"),
                testId: "suggested-prompt-confirm",
                compact: false,
              }))
            )
              return;
            await onChange(!enabled);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            pendingRef.current = false;
            setPending(false);
          }
        }}
      >
        {enabled ? (
          <span className="relative z-10 text-base" aria-hidden="true">
            🤔
          </span>
        ) : (
          <Sparkles className="size-3.5 text-foreground-subtle" aria-hidden="true" />
        )}
      </Button>
    </ControlHintTooltip>
  );
}
