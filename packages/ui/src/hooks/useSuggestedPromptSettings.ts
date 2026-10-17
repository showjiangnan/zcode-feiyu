// Modified by ZCode Feiyu.
import { useRef, useState } from "react";
import type { SuggestedPromptSettings } from "@zcode/shared";
import { validateModelSelectionOptions } from "@zcode/provider";
import { useSettings } from "./useSettingService.js";
import { useServices } from "./useServices.js";
import { useModelSelectionServiceView } from "./useModelSelectionView.js";

export function useSuggestedPromptSettings() {
  const { settings, update, loading } = useSettings();
  const { modelSelectionService } = useServices();
  const { state } = useModelSelectionServiceView(modelSelectionService);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const config = settings?.suggestedPrompt ?? { enabled: false };
  const view =
    state.status === "ready"
      ? {
          ...state.view,
          providers: state.view.providers
            .map((provider) => ({
              ...provider,
              models: provider.models.filter(
                (model) => model.config.properties.outputFormat.supportsText,
              ),
            }))
            .filter((provider) => provider.models.length > 0),
        }
      : null;
  const selection = config.modelSelection;
  const model =
    selection &&
    view?.providers
      .find((p) => p.providerId === selection.providerId)
      ?.models.find((m) => m.modelId === selection.modelId);
  const valid = Boolean(selection && model && validateModelSelectionOptions(model, selection).ok);
  const save = async (next: SuggestedPromptSettings) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await update({ suggestedPrompt: next });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  return { config, view, state, valid, pending: pending || loading, error, save };
}
