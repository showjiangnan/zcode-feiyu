// Modified by ZCode Feiyu.
import {
  chatGPTSubscriptionViewSchema,
  getCapturedZCodeSubscriptionBrokerEnv,
} from "@zcode/shared";
import type { IChatGPTSubscriptionService } from "../contract.js";
import { ChatGPTSubscriptionError, parseSubscriptionError } from "../domain/errors.js";

/** Host/RCS 只能读取或刷新现有目录；首次 OAuth 与账号管理限定在受信任桌面页面。 */
export function createSubscriptionViewClient(env: NodeJS.ProcessEnv): IChatGPTSubscriptionService {
  return {
    async execute(command) {
      const authority =
        env.ZCODE_SUBSCRIPTION_BROKER_URL || env.ZCODE_SUBSCRIPTION_BROKER_CAPABILITY
          ? env
          : getCapturedZCodeSubscriptionBrokerEnv();
      const base = authority.ZCODE_SUBSCRIPTION_BROKER_URL,
        capability = authority.ZCODE_SUBSCRIPTION_BROKER_CAPABILITY;
      if (!base || !capability)
        return {
          revision: 0,
          available: false,
          unavailableReason: "subscription_managed_host_required",
          connection: null,
          pending: null,
        };
      if (command.type !== "read" && command.type !== "refresh-models")
        throw new ChatGPTSubscriptionError("desktop_authorization_required");
      const url = new URL(base);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new ChatGPTSubscriptionError("managed_host_invalid");
      const response = await fetch(
        `${base}/${command.type === "read" ? "view" : "refresh-models"}`,
        {
          method: command.type === "read" ? "GET" : "POST",
          redirect: "error",
          headers: { authorization: `Bearer ${capability}` },
          signal: AbortSignal.timeout(35_000),
        },
      );
      const value = await response.json();
      if (!response.ok) throw parseSubscriptionError(value, response.status);
      return chatGPTSubscriptionViewSchema.parse(value);
    },
  };
}
