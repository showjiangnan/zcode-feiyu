import { useEffect, useRef, useState } from "react";
import { DownloadIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useProviderDetailFeedback } from "./ProviderDetailFeedback.js";

function useActionState() {
  const [pending, setPending] = useState(false);
  const active = useRef(true);
  const running = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return { pending, active, running, setPending };
}

export function DiscoverModelsButton({ onDiscover }: { onDiscover: () => Promise<number> }) {
  const { intl } = useZCodeIntl();
  const { showFeedback, dismissFeedback } = useProviderDetailFeedback();
  const state = useActionState();
  const discover = async () => {
    if (state.running.current) return;
    state.running.current = true;
    state.setPending(true);
    dismissFeedback("discover-models");
    try {
      const count = await onDiscover();
      if (state.active.current)
        showFeedback({
          key: "discover-models",
          state: "success",
          message: intl.formatMessage({ id: "settings.modelProvider.modelsDiscovered" }, { count }),
          dismissible: true,
        });
    } catch (error) {
      const kind =
        error instanceof Error && error.message.startsWith("teamorouter:")
          ? error.message.slice("teamorouter:".length)
          : "failed";
      const known = [
        "missing-key",
        "unauthorized",
        "invalid-response",
        "no-models",
        "network-error",
        "server-error",
        "conflict",
        "unsupported",
      ].includes(kind)
        ? kind
        : "failed";
      if (state.active.current)
        showFeedback({
          key: "discover-models",
          state: "failure",
          message: intl.formatMessage({ id: `settings.modelProvider.discoveryError.${known}` }),
          dismissible: true,
        });
    } finally {
      state.running.current = false;
      if (state.active.current) state.setPending(false);
    }
  };
  return (
    <Button
      type="button"
      variant="secondary"
      size="default"
      className="rounded-lg"
      disabled={state.pending}
      data-testid="model-provider-discover-models"
      onClick={() => void discover()}
    >
      {state.pending ? (
        <Loader2Icon data-icon="inline-start" className="animate-spin" aria-hidden="true" />
      ) : (
        <DownloadIcon data-icon="inline-start" aria-hidden="true" />
      )}
      {intl.formatMessage({
        id: state.pending
          ? "settings.modelProvider.discoveringModels"
          : "settings.modelProvider.discoverModels",
      })}
    </Button>
  );
}
