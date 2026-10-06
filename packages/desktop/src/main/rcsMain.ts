import { app, BrowserWindow, ipcMain, safeStorage, type UtilityProcess } from "electron";
import { join } from "node:path";
import { z } from "zod";
import {
  PlatformChannels,
  rcsSaveSchema,
  normalizeRcsEndpoint,
  type RcsPlatform,
} from "@zcode/shared";
import { RcsSettingsStore } from "./rcsSettingsStore.js";
import { RcsHostBridge } from "./rcsHostBridge.js";
import { RcsConnection } from "./rcsConnection.js";

export function installRcsMain(
  hosts: Map<number, UtilityProcess>,
): RcsPlatform & { dispose(): void } {
  const store = new RcsSettingsStore(join(app.getPath("userData"), "rcs.json"), safeStorage);
  const bridge = new RcsHostBridge({
    hosts: () => hosts,
    send: (id, payload) => connection.send(id, payload),
    closed: (id) => connection.attachmentClosed(id),
  });
  const connection = new RcsConnection(store, bridge);
  const service: RcsPlatform = {
    getSettings: () => store.getSettings(),
    saveSettings: async (input) => {
      const result = await store.saveSettings(input);
      await connection.apply();
      return result;
    },
    getStatus: async () => connection.getStatus(),
    validate: (input) => connection.validate(input),
    reconnect: () => connection.apply(),
    listHosts: () => bridge.listHosts(),
    listClients: () => connection.listClients(),
    revokeClient: (id) => connection.revokeClient(id),
  };
  ipcMain.handle(PlatformChannels.Rcs, async (event, action: unknown, input: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    // 原生主窗口的 preload 才能访问设备根配置；guest webContents 不获得该权限。
    if (!window || !hosts.has(event.sender.id) || event.senderFrame !== event.sender.mainFrame)
      throw new Error("CAPABILITY_DENIED");
    if (action === "saveSettings") return service.saveSettings(rcsSaveSchema.parse(input));
    if (action === "validate") {
      const value = z
        .object({ endpoint: z.string().max(2048), key: z.string().min(32).max(512).optional() })
        .strict()
        .parse(input);
      value.endpoint = normalizeRcsEndpoint(value.endpoint);
      return service.validate(value);
    }
    if (action === "revokeClient")
      return service.revokeClient(
        z
          .string()
          .regex(/^[a-f0-9]{32}$/)
          .parse(input),
      );
    if (input !== undefined) throw new Error("RCS_REQUEST_INVALID");
    switch (action) {
      case "getSettings":
        return service.getSettings();
      case "getStatus":
        return service.getStatus();
      case "reconnect":
        return service.reconnect();
      case "listHosts":
        return service.listHosts();
      case "listClients":
        return service.listClients();
      default:
        throw new Error("RCS_REQUEST_INVALID");
    }
  });
  void connection.apply().catch(() => {});
  return {
    ...service,
    dispose: () => {
      connection.dispose();
      ipcMain.removeHandler(PlatformChannels.Rcs);
    },
  };
}
