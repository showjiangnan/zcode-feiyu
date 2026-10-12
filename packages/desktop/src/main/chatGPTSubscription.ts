// Modified by ZCode Feiyu.
import { safeStorage, shell, ipcMain, type BrowserWindow } from "electron";
import { join } from "node:path";
import { createDesktopSubscriptionOwner } from "@zcode/services/chatgpt-subscription/node";
import { createHostApiNetworkTransport, getAppConfigDir } from "@zcode/services/node";
import {
  PlatformChannels,
  chatGPTSubscriptionCommandSchema,
  chatGPTSubscriptionViewSchema,
  type AppSettings,
  type ChatGPTSubscriptionView,
} from "@zcode/shared";

/** Main 只装配原生能力与可信 IPC；连接业务归 services owner。 */
export async function installChatGPTSubscription(options: {
  loadSettings(): Promise<AppSettings>;
  windows(): BrowserWindow[];
}) {
  const network = createHostApiNetworkTransport(
    async () => {
      const settings = await options.loadSettings();
      return {
        httpProxy: settings.httpProxy,
        noProxy: settings.httpProxyNoProxy,
        caCertPath: settings.httpProxyCaCertPath,
      };
    },
    { cacheOptions: false },
  );
  const cipher = {
    id: "electron-safe-storage-v1",
    available: () =>
      (process.platform === "darwin" || process.platform === "win32") &&
      safeStorage.isEncryptionAvailable(),
    async encrypt(value: string) {
      if (!this.available()) throw new Error("secure_storage_unavailable");
      return safeStorage.encryptString(value).toString("base64");
    },
    async decrypt(value: string) {
      if (!this.available()) throw new Error("secure_storage_unavailable");
      return safeStorage.decryptString(Buffer.from(value, "base64"));
    },
  };
  let owner: Awaited<ReturnType<typeof createDesktopSubscriptionOwner>> | undefined;
  let unavailableReason = "secure_storage_unavailable";
  try {
    owner = await createDesktopSubscriptionOwner({
      directory: getAppConfigDir(),
      projectionFile: join(getAppConfigDir(), "chatgpt-subscription.providers.json"),
      cipher,
      fetch: network.fetch,
      openBrowser: (url) => shell.openExternal(url),
    });
  } catch {
    unavailableReason = "credential_store_unavailable";
  }
  const unavailable: ChatGPTSubscriptionView = {
    revision: 0,
    available: false,
    unavailableReason,
    connection: null,
    pending: null,
  };
  ipcMain.handle(PlatformChannels.ChatGPTSubscriptionExecute, async (event, input: unknown) => {
    // 插件 webview/Gen UI/子 frame 即使共享 preload 也不能操作账户。
    if (
      event.senderFrame !== event.sender.mainFrame ||
      !options.windows().some((win) => win.webContents === event.sender)
    )
      throw new Error("desktop_authorization_required");
    const command = chatGPTSubscriptionCommandSchema.parse(input);
    if (!owner) return unavailable;
    try {
      return chatGPTSubscriptionViewSchema.parse(await owner.execute(command));
    } catch (error) {
      const safe = error as { code?: unknown; status?: unknown; requestId?: unknown };
      const view = await owner.execute({ type: "read" }).catch(() => unavailable);
      return chatGPTSubscriptionViewSchema.parse({
        ...view,
        error: {
          code: typeof safe.code === "string" ? safe.code : "subscription_operation_failed",
          ...(typeof safe.status === "number" ? { status: safe.status } : {}),
          ...(typeof safe.requestId === "string" ? { requestId: safe.requestId } : {}),
        },
      });
    }
  });
  return {
    env: owner?.env ?? {},
    async dispose() {
      ipcMain.removeHandler(PlatformChannels.ChatGPTSubscriptionExecute);
      await owner?.dispose();
      await network.disposeAndWait();
    },
  };
}
