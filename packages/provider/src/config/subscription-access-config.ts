// Modified by ZCode Feiyu.
import { ConfigOverlay, type ConfigValidationIssue } from "../config-overlay.js";
import { chatGPTSubscriptionAccessDataSchema } from "./provider-data-schema.js";
import { validateConfigSchema } from "./schema-validation.js";
import type { z } from "zod";

export type ChatGPTSubscriptionAccessConfigObject = z.infer<
  typeof chatGPTSubscriptionAccessDataSchema
>;
export class ChatGPTSubscriptionAccessConfig extends ConfigOverlay<ChatGPTSubscriptionAccessConfig> {
  readonly type = "chatgpt-subscription" as const;
  readonly profileId: string;
  readonly generation: number;
  readonly entitled: boolean;
  readonly label: string;
  readonly modelDisplayNames?: Readonly<Record<string, string>>;
  constructor(input: Omit<ChatGPTSubscriptionAccessConfigObject, "type">) {
    super();
    this.profileId = input.profileId;
    this.generation = input.generation;
    this.entitled = input.entitled;
    this.label = input.label;
    this.modelDisplayNames = input.modelDisplayNames
      ? Object.freeze({ ...input.modelDisplayNames })
      : undefined;
    Object.freeze(this);
  }
  overlay(next: ChatGPTSubscriptionAccessConfig): ChatGPTSubscriptionAccessConfig {
    return next;
  }
  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(chatGPTSubscriptionAccessDataSchema, this.toJSON(), path);
  }
  toJSON(): ChatGPTSubscriptionAccessConfigObject {
    return {
      type: this.type,
      profileId: this.profileId,
      generation: this.generation,
      entitled: this.entitled,
      label: this.label,
      ...(this.modelDisplayNames ? { modelDisplayNames: { ...this.modelDisplayNames } } : {}),
    };
  }
}
