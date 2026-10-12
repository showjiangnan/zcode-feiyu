// Modified by ZCode Feiyu.
import type { ModelUsage } from "@zcode/contracts";
import type { AiSdkGenerateTextResult } from "./runner-runtime.js";

export type GenerateTextResultWithMetadata = AiSdkGenerateTextResult & {
  request?: { body?: unknown };
  response?: {
    body?: unknown;
    headers?: Record<string, string>;
    id?: string;
    messages?: unknown[];
    modelId?: string;
    timestamp?: Date;
  };
  steps?: unknown[];
};

export interface StreamDiagnostics {
  chunkCounts: Record<string, number>;
  errorChunkCount: number;
  finishReason?: string;
  lastChunkType?: string;
  lastErrorChunk?: unknown;
  lastFinishChunk?: unknown;
  rawFinishReason?: unknown;
  reasoningDeltaChars: number;
  textDeltaChars: number;
  toolCallCount: number;
  usage?: ModelUsage;
}
