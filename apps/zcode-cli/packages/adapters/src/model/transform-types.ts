// Modified by ZCode Feiyu.
import { type ModelInputFormat } from "@zcode/contracts";
import { type ModelMessage as AiSdkModelMessage, type ToolResultPart } from "ai";

export interface AiSdkMessageTransformOptions {
  apiFormat?: string;
  providerOptions?: Record<string, unknown>;
  providerKind?: "openai" | "anthropic" | "openai-compatible" | "gateway" | "custom";
  stripMedia?: boolean;
  inputFormat?: ModelInputFormat;
}

export type AiSdkAssistantMessage = Extract<AiSdkModelMessage, { role: "assistant" }>;

export type AiSdkAssistantContent = AiSdkAssistantMessage["content"];

export type AiSdkAssistantContentPart = Extract<AiSdkAssistantContent, unknown[]>[number];

export type AiSdkToolResultOutput = ToolResultPart["output"];

export type AiSdkProviderOptions = NonNullable<
  Extract<AiSdkModelMessage, { role: "system" }>["providerOptions"]
>;

export type AiSdkAssistantTransformOptions = AiSdkMessageTransformOptions & {
  stripOpenAiResponsesStoredReasoning?: boolean;
};

export type AiSdkUserContent = Extract<AiSdkModelMessage, { role: "user" }>["content"];
