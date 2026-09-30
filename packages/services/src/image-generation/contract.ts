// Modified by ZCode Feiyu contributors (2026).
import { ServiceChannels, type ImageGenerationConfig } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ImageModelOption {
  id: string;
  name: string;
  category: string;
}
export interface ImageGenerationSettings {
  config: ImageGenerationConfig;
  hasCredential: boolean;
}
/** Renderer-safe configuration facade. Execution is a private Host reverse-RPC dependency. */
export interface IImageGenerationService {
  getSettings(): Promise<ImageGenerationSettings>;
  saveSettings(input: {
    config: ImageGenerationConfig;
    apiKey?: string;
    clearKey?: boolean;
  }): Promise<ImageGenerationSettings>;
  listModels(draft?: {
    config: ImageGenerationConfig;
    apiKey?: string;
  }): Promise<ImageModelOption[]>;
  validate(draft?: {
    config: ImageGenerationConfig;
    apiKey?: string;
  }): Promise<{ ok: true; model: string; editModel?: string }>;
}
export const IImageGenerationService = createServiceDescriptor<IImageGenerationService>(
  ServiceChannels.ImageGeneration,
);
