// Modified by ZCode Feiyu contributors (2026).
import { useCallback, useEffect, useState } from "react";
import {
  IMAGE_SETTINGS_CHANGED_CHANNEL,
  imageGenerationConfigSchema,
  type ImageGenerationConfig,
} from "@zcode/shared";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useSettings } from "./useSettingService.js";
import { usePlatform } from "./usePlatform.js";
import type { ImageModelOption } from "@zcode/services";
import { useServices } from "./useServices.js";
import { useZCodeSessionService } from "./useZCodeSessionService.js";
import { invalidateDeferredDraftSessionForRuntimeChange } from "@/lib/zcodeDraftSkillInvalidation.js";

export function useImageGenerationSettings(
  workspacePath?: string | null,
  workspaceIdentity?: string,
) {
  const { imageGenerationService: service, broadcastService } = useServices();
  const platform = usePlatform();
  const { refresh } = useSettings();
  const zcodeSessionService = useZCodeSessionService(
    workspacePath ?? undefined,
    undefined,
    workspaceIdentity,
  );
  const [config, setConfig] = useState<ImageGenerationConfig>(() =>
    imageGenerationConfigSchema.parse({}),
  );
  const [hasCredential, setHasCredential] = useState(false),
    [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ImageModelOption[]>([]);
  const [pending, setPending] = useState(true),
    [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<"saved" | "validated" | null>(null);
  useEffect(() => {
    let alive = true;
    setPending(true);
    if (!service) {
      setError("Image generation is unavailable on this Host.");
      setPending(false);
      return;
    }
    void service
      .getSettings()
      .then((result) => {
        if (alive) {
          setConfig(result.config);
          setHasCredential(result.hasCredential);
        }
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
    };
  }, [service]);
  const act = useCallback(async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }, []);
  const save = (next = config, clearKey = false) =>
    act(async () => {
      if (!service) throw new Error("Image service unavailable.");
      const result = await service.saveSettings({
        config: imageGenerationConfigSchema.parse(next),
        ...(clearKey ? { clearKey: true } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setConfig(result.config);
      setHasCredential(result.hasCredential);
      setApiKey("");
      platform.syncAppSettings?.({ imageGeneration: result.config });
      await refresh();
      useZCodeSessionStore.getState().invalidateAllDraftRuntimes();
      await invalidateDeferredDraftSessionForRuntimeChange({
        logScope: "image-generation",
        reason: "image-generation-settings",
        workspacePath,
        workspaceIdentity,
        zcodeSessionService,
      });
      await broadcastService.send({
        channel: IMAGE_SETTINGS_CHANGED_CHANNEL,
        payload: { version: 1 },
      });
      setNotice("saved");
    });
  const draft = () => ({
    config: imageGenerationConfigSchema.parse(config),
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
  });
  return {
    config,
    setConfig,
    hasCredential,
    apiKey,
    setApiKey,
    models,
    pending,
    error,
    notice,
    save,
    refreshModels: () =>
      act(async () => {
        if (!service) throw new Error("Image service unavailable.");
        setModels(await service.listModels(draft()));
      }),
    validate: () =>
      act(async () => {
        if (!service) throw new Error("Image service unavailable.");
        await service.validate(draft());
        setNotice("validated");
      }),
  };
}
