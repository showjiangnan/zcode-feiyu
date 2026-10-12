// Modified by ZCode Feiyu.
import { atomicWritePrivateTextFile } from "@zcode/shared/node";
import { join } from "node:path";
import { ChatGPTSubscriptionService } from "./app/service.js";
import { createSubscriptionPrivateStore } from "./adapters/privateStore.js";
import { createSubscriptionOAuth } from "./adapters/oauth.js";
import { createSubscriptionProjection } from "./adapters/projection.js";
import { startSubscriptionBroker } from "./adapters/broker.js";
import type { SubscriptionCipher } from "./app/ports.js";

export { createSubscriptionViewClient } from "./adapters/client.js";
export type { SubscriptionCipher } from "./app/ports.js";

/** 安装级凭据 owner；Electron 只注入系统密码保护与系统浏览器。 */
export async function createDesktopSubscriptionOwner(options: {
  directory: string;
  projectionFile: string;
  cipher: SubscriptionCipher;
  fetch: typeof fetch;
  openBrowser(url: string): Promise<void>;
}) {
  const store = createSubscriptionPrivateStore(
    join(options.directory, "chatgpt-subscription"),
    options.cipher,
  );
  const publish = createSubscriptionProjection(store, options.projectionFile);
  const oauth = createSubscriptionOAuth({ fetch: options.fetch, openBrowser: options.openBrowser });
  const owner = new ChatGPTSubscriptionService({
    store,
    oauth,
    fetch: options.fetch,
    publish,
    isStorageAvailable: () => options.cipher.available(),
  });
  const disableProjection = () =>
    atomicWritePrivateTextFile(
      options.projectionFile,
      JSON.stringify({
        version: 1,
        providers: [],
        models: { providerModelRules: [], manualProviderModelRules: [] },
      }),
    );
  try {
    if (options.cipher.available()) {
      await store.transaction(async (state, save) => {
        for (const p of state.profiles) if (p.catalogState === "fresh") p.catalogState = "cached";
        await save(state);
      });
      await publish();
    } else await disableProjection();
  } catch (error) {
    await disableProjection();
    throw error;
  }
  // 上次安装 owner 已终结的旧连接不参与自动账号轮换。
  void owner.cleanupRetired().catch(() => undefined);
  const broker = await startSubscriptionBroker(owner, options.fetch);
  return {
    execute: owner.execute.bind(owner),
    env: broker.env,
    dispose: async () => {
      await broker.dispose();
      await owner.cleanupRetired();
    },
  };
}
