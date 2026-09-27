import {
  imageGenerationConfigSchema,
  imageGenerationRequestSchema,
  imageGenerationResponseSchema,
  type ImageGenerationRequest,
  type ImageGenerationResponse,
} from "@zcode/shared";
import { z } from "zod";
import type { ISettingService } from "../setting/setting.js";
import type { ICredentialService } from "../credential/credential.js";
import type { IImageGenerationService } from "./contract.js";
import { FalImageAdapter } from "./falAdapter.js";
import { detectImageMime, imageApiUrl } from "./falNetwork.js";

const saveSchema = z
  .object({
    config: imageGenerationConfigSchema,
    apiKey: z.string().trim().min(1).max(4096).optional(),
    clearKey: z.boolean().optional(),
  })
  .strict();
export function createImageGenerationService(deps: {
  settings: ISettingService;
  credentials: ICredentialService;
  fetch: typeof fetch;
}) {
  const adapter = new FalImageAdapter(deps.fetch);
  const config = async () =>
    imageGenerationConfigSchema.parse((await deps.settings.get()).imageGeneration ?? {});
  const credentialId = (apiUrl: string) => `image-generation:${imageApiUrl(apiUrl).origin}`;
  const key = async (apiUrl: string) => {
    const value = await deps.credentials.load(credentialId(apiUrl));
    if (!value) throw new Error("Configure an image generation API key in Settings.");
    return value;
  };
  const service: IImageGenerationService = {
    async getSettings() {
      const current = await config();
      return {
        config: current,
        hasCredential: Boolean(await deps.credentials.load(credentialId(current.apiUrl))),
      };
    },
    async saveSettings(input) {
      const parsed = saveSchema.parse(input);
      imageApiUrl(parsed.config.apiUrl);
      if (parsed.clearKey && parsed.apiKey)
        throw new Error("Cannot save and clear an API key together.");
      if (parsed.apiKey)
        await deps.credentials.save(credentialId(parsed.config.apiUrl), parsed.apiKey);
      if (parsed.clearKey) await deps.credentials.delete(credentialId(parsed.config.apiUrl));
      if (
        parsed.config.enabled &&
        !(await deps.credentials.load(credentialId(parsed.config.apiUrl)))
      )
        throw new Error("Save an API key before enabling image generation.");
      await deps.settings.update({ imageGeneration: parsed.config });
      return service.getSettings();
    },
    async listModels(draft) {
      const parsed = draft ? saveSchema.parse(draft) : undefined;
      const current = parsed?.config ?? (await config());
      return adapter
        .withDeadline()
        .listModels(current, parsed?.apiKey ?? (await key(current.apiUrl)));
    },
    async validate(draft) {
      const parsed = draft ? saveSchema.parse(draft) : undefined;
      const current = parsed?.config ?? (await config());
      await adapter.withDeadline().validate(current, parsed?.apiKey ?? (await key(current.apiUrl)));
      return { ok: true, model: current.model, editModel: current.editModel };
    },
  };
  const request = async (raw: ImageGenerationRequest): Promise<ImageGenerationResponse> => {
    const scopedAdapter = adapter.withDeadline();
    const input = imageGenerationRequestSchema.parse(raw),
      current = await service.getSettings(),
      operation = input.operation;
    if (operation.type === "config") return { type: "config", ...current };
    if (operation.type === "submit") {
      let prepared, secret: string;
      try {
        if (!current.config.enabled || !operation.config.enabled)
          throw new Error("Image generation is disabled.");
        if (
          input.childSession &&
          (!current.config.allowSubagents || !operation.config.allowSubagents)
        )
          throw new Error("Image generation is disabled for subagents.");
        if (operation.config.apiUrl !== current.config.apiUrl)
          throw new Error("Image provider changed. Start a new session.");
        if (operation.references.length !== operation.input.referenceImages.length)
          throw new Error("Reference image count mismatch.");
        for (const reference of operation.references) {
          const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
            reference,
          );
          if (!match || detectImageMime(Buffer.from(match[2]!, "base64")) !== match[1])
            throw new Error("Invalid image reference.");
        }
        secret = await key(current.config.apiUrl);
        prepared = await scopedAdapter.prepare(
          operation.config,
          operation.input,
          operation.references,
          secret,
        );
        // schema 拉取期间用户可能关闭服务；付费 POST 前重新读取授权，不能沿用预检前的许可。
        secret = await key(current.config.apiUrl);
        const latest = await config();
        if (!latest.enabled || (input.childSession && !latest.allowSubagents))
          throw new Error("Image generation was disabled before submission.");
        if (latest.apiUrl !== operation.config.apiUrl)
          throw new Error("Image provider changed. Start a new session.");
      } catch (error) {
        // 预检尚未发送付费 POST，明确告知运行时失败，不能误记为提交结果未知。
        return {
          type: "rejected",
          message: (error instanceof Error ? error.message : "Image preflight failed.").slice(
            0,
            2000,
          ),
        };
      }
      return {
        type: "submitted",
        ticket: await scopedAdapter.submit(operation.config, prepared, secret),
      };
    }
    if (imageApiUrl(operation.ticket.apiUrl).origin !== imageApiUrl(current.config.apiUrl).origin)
      throw new Error("Restore the original image provider address to recover this request.");
    const secret = await key(operation.ticket.apiUrl);
    const result =
      operation.type === "status"
        ? await scopedAdapter.status(operation.ticket, secret)
        : operation.type === "cancel"
          ? await scopedAdapter.cancel(operation.ticket, secret)
          : await scopedAdapter.download(
              operation.ticket,
              operation.index,
              operation.offset,
              secret,
            );
    return imageGenerationResponseSchema.parse(result);
  };
  return { service, request };
}
