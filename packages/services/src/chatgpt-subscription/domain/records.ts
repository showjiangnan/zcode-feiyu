// Modified by ZCode Feiyu.
import { z } from "zod";
import {
  chatGPTSubscriptionModelSchema,
  subscriptionCatalogJsonSchema,
} from "@zcode/shared/chatgpt-subscription-catalog";

export const subscriptionModelSchema = chatGPTSubscriptionModelSchema
  .extend({
    nativeMetadata: z.record(z.string().max(128), subscriptionCatalogJsonSchema).optional(),
  })
  .strict();

export const tokenSetSchema = z
  .object({
    accessToken: z.string().min(1).optional(),
    refreshToken: z.string().min(1).optional(),
    idToken: z.string().min(1),
    expiresAt: z.number().finite(),
    earliestRefreshAt: z.number().finite().optional(),
    identityVerificationRequired: z.boolean().optional(),
    scopes: z.array(z.string()),
  })
  .strict();

export const profileSchema = z
  .object({
    profileId: z.string().uuid(),
    issuer: z.string().url(),
    subject: z.string().min(1),
    clientId: z.string().min(1),
    label: z.string().min(1),
    email: z.string().optional(),
    generation: z.number().int().nonnegative(),
    authorizationStartedAt: z.number().finite().optional(),
    retiredAt: z.number().finite().optional(),
    credentialRevision: z.number().int().nonnegative(),
    status: z.enum([
      "connected",
      "identity-only",
      "signed-out",
      "reauthorization-required",
      "verification-pending",
    ]),
    tokens: tokenSetSchema.optional(),
    pendingTokens: tokenSetSchema.optional(),
    catalogRevision: z.number().int().nonnegative(),
    models: z.array(subscriptionModelSchema),
    catalogState: z.enum(["empty", "fresh", "cached", "failed"]),
    catalogError: z.string().optional(),
    remoteRevocation: z.enum(["confirmed", "unconfirmed"]).optional(),
    usageAcknowledged: z.boolean(),
  })
  .strict();

export const subscriptionStoreSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    activeProfileId: z.string().uuid().nullable(),
    pendingRegistration: z
      .object({
        clientId: z.string().min(1),
        kind: z.enum(["sign-in", "switch", "reauthorize"]),
        activeProfileId: z.string().uuid().nullable(),
      })
      .strict()
      .optional(),
    profiles: z.array(profileSchema),
  })
  .strict()
  .superRefine((store, ctx) => {
    if (new Set(store.profiles.map((p) => p.profileId)).size !== store.profiles.length)
      ctx.addIssue({ code: "custom", message: "duplicate profile" });
    if (store.activeProfileId && !store.profiles.some((p) => p.profileId === store.activeProfileId))
      ctx.addIssue({ code: "custom", message: "missing active profile" });
  });

export type SubscriptionTokens = z.infer<typeof tokenSetSchema>;
export type SubscriptionProfile = z.infer<typeof profileSchema>;
export type SubscriptionStore = z.infer<typeof subscriptionStoreSchema>;
export const emptySubscriptionStore = (): SubscriptionStore => ({
  version: 1,
  revision: 0,
  activeProfileId: null,
  profiles: [],
});

export function hasSubscriptionPermission(tokens: SubscriptionTokens | undefined): boolean {
  return (
    !!tokens?.accessToken &&
    tokens.scopes.includes("chatgpt.tokens.use.direct") &&
    tokens.scopes.includes("resource.invoke")
  );
}
