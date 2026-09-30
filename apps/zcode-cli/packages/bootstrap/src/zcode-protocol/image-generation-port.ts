// Modified by ZCode Feiyu contributors (2026).
import { open, realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { relative, resolve, isAbsolute, sep } from "node:path";
import { imageGenerationResponseSchema, zcodeProtocolMethods } from "@zcode/shared";
import type { ImageGenerationPort } from "@zcode/contracts";
import { ProtocolRequestError, type ZCodeProtocolAgentServerContext } from "./server-types.js";

const MAX_REFERENCE_BYTES = 3 * 1024 * 1024;
export async function createProtocolImageGenerationPort(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<ImageGenerationPort | undefined> {
  const result = await context
    .requestClient(
      zcodeProtocolMethods.interactionImageGeneration,
      {
        sourceSessionId: sessionId,
        traceId: sessionId,
        childSession: false,
        operation: { type: "config" },
      },
      imageGenerationResponseSchema,
    )
    .catch((error: unknown) => {
      if (error instanceof ProtocolRequestError && [-32601, -32602].includes(error.code))
        return undefined;
      throw error;
    });
  if (!result) return undefined;
  if (result.type !== "config") throw new Error("Invalid image capability response.");
  return {
    config: { ...result.config, enabled: result.config.enabled && result.hasCredential },
    request: (input) =>
      context.requestClient(
        zcodeProtocolMethods.interactionImageGeneration,
        input,
        imageGenerationResponseSchema,
      ),
    wait: async (milliseconds, signal) => {
      await delay(milliseconds, undefined, { signal });
    },
    async readReference(input, signal) {
      signal.throwIfAborted();
      const root = await realpath(input.workspaceRoot);
      const path = await realpath(resolve(root, input.path));
      const rel = relative(root, path);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error(
          "Reference image must be inside the current workspace or a session artifact.",
        );
      const file = await open(path, "r");
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_REFERENCE_BYTES)
          throw new Error("Reference image must be a file of at most 3 MiB.");
        const data = await file.readFile({ signal });
        if (data.length > MAX_REFERENCE_BYTES) throw new Error("Reference image exceeds 3 MiB.");
        const mime =
          data[0] === 137 && data.subarray(1, 4).toString() === "PNG"
            ? "image/png"
            : data[0] === 255 && data[1] === 216
              ? "image/jpeg"
              : data.subarray(0, 4).toString() === "RIFF" &&
                  data.subarray(8, 12).toString() === "WEBP"
                ? "image/webp"
                : undefined;
        if (!mime) throw new Error("Reference image must be PNG, JPEG or WebP.");
        return `data:${mime};base64,${data.toString("base64")}`;
      } finally {
        await file.close();
      }
    },
  };
}
