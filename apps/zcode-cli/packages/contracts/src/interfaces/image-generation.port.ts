// Modified by ZCode Feiyu contributors (2026).
import type {
  ImageGenerationConfig,
  ImageGenerationRequest,
  ImageGenerationResponse,
} from "@zcode/shared";

export interface ImageGenerationPort {
  readonly config: ImageGenerationConfig;
  request(input: ImageGenerationRequest): Promise<ImageGenerationResponse>;
  readReference?(
    input: { path: string; workspaceRoot: string },
    signal: AbortSignal,
  ): Promise<string>;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}
