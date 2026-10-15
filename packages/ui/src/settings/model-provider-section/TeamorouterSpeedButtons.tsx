// Modified by ZCode Feiyu.
import { useId, useRef, useState } from "react";
import { getTeamorouterSpeedCapabilities, type ModelSpeedCapabilities } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { ModelSpeedIcon } from "@/chat-input-toolbar/ModelSpeedIcon.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useProviderDetailFeedback } from "./ProviderDetailFeedback.js";

export function TeamorouterSpeedButtons({
  capabilities,
  onChange,
}: {
  capabilities?: ModelSpeedCapabilities | null;
  onChange: (speed: "fast" | "ultrafast", enabled: boolean) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const id = useId();
  const { showFeedback } = useProviderDetailFeedback();
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const enabled = getTeamorouterSpeedCapabilities(capabilities);
  const toggle = async (speed: "fast" | "ultrafast") => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    try {
      await onChange(speed, !enabled[speed]);
    } catch {
      showFeedback({
        key: `speed-capability:${id}`,
        state: "failure",
        message: intl.formatMessage({ id: "settings.modelProvider.speed.saveFailed" }),
      });
    } finally {
      running.current = false;
      setPending(false);
    }
  };
  return (
    <>
      {(["fast", "ultrafast"] as const).map((speed) => {
        const label = intl.formatMessage(
          { id: "settings.modelProvider.speed.allow" },
          { speed: intl.formatMessage({ id: `chat.modelSpeed.${speed}` }) },
        );
        return (
          <ControlHintTooltip
            key={speed}
            title={label}
            description={intl.formatMessage({ id: "settings.modelProvider.speed.hint" })}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={
                enabled[speed] ? "shrink-0 text-icon-blue" : "shrink-0 text-foreground-subtlest"
              }
              aria-label={label}
              aria-pressed={enabled[speed]}
              disabled={pending}
              data-testid={`model-provider-speed-${speed}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void toggle(speed)}
            >
              <ModelSpeedIcon speed={speed} className="size-3.5" />
            </Button>
          </ControlHintTooltip>
        );
      })}
    </>
  );
}
