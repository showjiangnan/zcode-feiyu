// Modified by ZCode Feiyu.
import { zcodeProtocolMethods, zcodeRuntimeCapabilitiesSchema } from "@zcode/shared";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";

const checks = new WeakMap<object, Promise<boolean>>();

/** 旧 CLI 的 preferences 是 strict schema；缺失能力时不能写入新字段。 */
export function supportsSuggestedPrompt(
  client: Pick<ZCodeProtocolClient, "request">,
): Promise<boolean> {
  const previous = checks.get(client);
  if (previous) return previous;
  const check = client
    .request(zcodeProtocolMethods.runtimeCapabilities, {}, zcodeRuntimeCapabilitiesSchema)
    .then((result) => result.suggestedPrompt === true)
    .catch(() => {
      checks.delete(client);
      return false;
    });
  checks.set(client, check);
  return check;
}
