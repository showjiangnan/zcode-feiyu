// Modified by ZCode Feiyu.
import type { RegistryProviderAccessConfig } from "@zcode/provider";
import { getCapturedZCodeSubscriptionBrokerEnv } from "@zcode/shared";

/** 令牌留在安装级 owner；SDK 只有无效占位值，最终鉴权由私有 broker 添加。 */
export function createSubscriptionInferenceFetch(
  access: Extract<RegistryProviderAccessConfig, { type: "chatgpt-subscription" }>,
  env: Record<string, string | undefined>,
  execution?: {
    id: string;
    startedAt: number;
    parentId?: string;
    onSettled(dispose: () => Promise<void>): void;
  },
): typeof fetch {
  let registered = false;
  return async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input.toString());
    if (target.href !== "https://api.openai.com/v1/responses" || init?.method !== "POST")
      throw new Error("subscription_sharing_route_not_supported");
    const authority =
      env.ZCODE_SUBSCRIPTION_BROKER_URL || env.ZCODE_SUBSCRIPTION_BROKER_CAPABILITY
        ? env
        : getCapturedZCodeSubscriptionBrokerEnv();
    const base = authority.ZCODE_SUBSCRIPTION_BROKER_URL,
      capability = authority.ZCODE_SUBSCRIPTION_BROKER_CAPABILITY;
    if (!base || !capability) throw new Error("subscription_managed_host_required");
    const broker = new URL(base);
    if (
      broker.protocol !== "http:" ||
      broker.hostname !== "127.0.0.1" ||
      broker.username ||
      broker.password ||
      broker.pathname !== "/" ||
      broker.search ||
      broker.hash
    )
      throw new Error("subscription_managed_host_invalid");
    if (execution && !registered) {
      registered = true;
      execution.onSettled(async () => {
        await fetch(`${base}/execution/end`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(5000),
          headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
          body: JSON.stringify({ id: execution.id }),
        });
      });
    }
    return fetch(`${base}/responses`, {
      method: "POST",
      body: init.body,
      signal: init.signal,
      redirect: "error",
      headers: {
        authorization: `Bearer ${capability}`,
        "content-type": "application/json",
        "x-zcode-subscription-profile": access.profileId,
        "x-zcode-subscription-generation": String(access.generation),
        ...(execution
          ? {
              "x-zcode-execution-id": execution.id,
              "x-zcode-execution-started-at": String(execution.startedAt),
              ...(execution.parentId ? { "x-zcode-execution-parent": execution.parentId } : {}),
            }
          : {}),
      },
    });
  };
}
