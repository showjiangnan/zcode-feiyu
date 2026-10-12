// Modified by ZCode Feiyu.
import { z } from "zod";

export type ChatGPTConnectionStatus =
  | "connected"
  | "identity-only"
  | "signed-out"
  | "reauthorization-required"
  | "verification-pending";

export interface ChatGPTSubscriptionModel {
  slug: string;
  displayName: string;
  /** 未公开的能力保持未知，不从名称猜测。 */
  inputModalities?: string[];
  contextWindow?: number;
  contextWindowSource?: "official-model-reference" | "local-planning-fallback";
  reasoningLevels?: string[];
}

export interface ChatGPTSubscriptionConnection {
  profileId: string;
  label: string;
  email?: string;
  status: ChatGPTConnectionStatus;
  generation: number;
  scopes: string[];
  catalogRevision: number;
  models: ChatGPTSubscriptionModel[];
  catalogState: "empty" | "fresh" | "cached" | "failed";
  catalogError?: string;
  remoteRevocation?: "confirmed" | "unconfirmed";
  usageAcknowledged: boolean;
}

export interface ChatGPTSubscriptionView {
  revision: number;
  available: boolean;
  unavailableReason?: string;
  connection: ChatGPTSubscriptionConnection | null;
  pending: { attemptId: string; kind: "sign-in" | "switch" | "reauthorize" } | null;
  error?: { code: string; status?: number; requestId?: string };
}

export type ChatGPTSubscriptionCommand =
  | { type: "read" }
  | { type: "sign-in"; mode: "sign-in" | "switch" | "reauthorize"; enableUsage?: boolean }
  | { type: "cancel"; attemptId: string }
  | { type: "refresh-models" }
  | { type: "acknowledge-usage" }
  | { type: "sign-out" }
  | { type: "remove" };

export const chatGPTSubscriptionCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("read") }).strict(),
  z
    .object({
      type: z.literal("sign-in"),
      mode: z.enum(["sign-in", "switch", "reauthorize"]),
      enableUsage: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("cancel"), attemptId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("refresh-models") }).strict(),
  z.object({ type: z.literal("acknowledge-usage") }).strict(),
  z.object({ type: z.literal("sign-out") }).strict(),
  z.object({ type: z.literal("remove") }).strict(),
]);
export const chatGPTSubscriptionViewSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    available: z.boolean(),
    unavailableReason: z.string().optional(),
    connection: z
      .object({
        profileId: z.string().uuid(),
        label: z.string(),
        email: z.string().optional(),
        status: z.enum([
          "connected",
          "identity-only",
          "signed-out",
          "reauthorization-required",
          "verification-pending",
        ]),
        generation: z.number().int().nonnegative(),
        scopes: z.array(z.string()),
        catalogRevision: z.number().int().nonnegative(),
        models: z.array(
          z
            .object({
              slug: z.string(),
              displayName: z.string(),
              inputModalities: z.array(z.string()).optional(),
              contextWindow: z.number().positive().optional(),
              contextWindowSource: z
                .enum(["official-model-reference", "local-planning-fallback"])
                .optional(),
              reasoningLevels: z.array(z.string()).optional(),
            })
            .strict(),
        ),
        catalogState: z.enum(["empty", "fresh", "cached", "failed"]),
        catalogError: z.string().optional(),
        remoteRevocation: z.enum(["confirmed", "unconfirmed"]).optional(),
        usageAcknowledged: z.boolean(),
      })
      .strict()
      .nullable(),
    pending: z
      .object({ attemptId: z.string().uuid(), kind: z.enum(["sign-in", "switch", "reauthorize"]) })
      .strict()
      .nullable(),
    error: z
      .object({
        code: z.string(),
        status: z.number().int().optional(),
        requestId: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
