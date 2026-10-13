// Modified by ZCode Feiyu.
import { BrowserWindow } from "electron";

const PREVIEW_URL = "about:blank#zcode-computer-control-preview";
const prepared = new WeakSet<BrowserWindow>();

export function prepareComputerControlPreviewWindow(parent: BrowserWindow): void {
  if (parent.isDestroyed() || prepared.has(parent)) return;
  prepared.add(parent);
  const children = new Set<BrowserWindow>();
  const originalThrottling = parent.webContents.getBackgroundThrottling();
  const updateThrottling = () => {
    if (!parent.isDestroyed())
      parent.webContents.setBackgroundThrottling(
        [...children].some(
          (child) => !child.isDestroyed() && child.isVisible() && !child.isMinimized(),
        )
          ? false
          : originalThrottling,
      );
  };
  // 子窗只显示 opener 的 React 投影；不执行应用 bootstrap，也不创建 Host。
  parent.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url !== PREVIEW_URL || frameName !== "zcode-computer-control-preview")
      return { action: "deny" };
    return {
      action: "allow",
      createWindow: (options) => {
        // 显式创建无 preload 的子窗，不能继承主窗口的原生桥接权限。
        const child = new BrowserWindow({
          ...options,
          title: "ZCode",
          width: 380,
          height: 320,
          minWidth: 300,
          minHeight: 220,
          alwaysOnTop: true,
          fullscreenable: false,
          resizable: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webviewTag: false,
          },
        });
        children.add(child);
        updateThrottling();
        child.on("show", updateThrottling);
        child.on("hide", updateThrottling);
        child.on("minimize", updateThrottling);
        child.on("restore", updateThrottling);
        child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        child.webContents.on("will-navigate", (event) => event.preventDefault());
        child.webContents.on("will-redirect", (event) => event.preventDefault());
        child.webContents.on("dom-ready", () => {
          // 无 preload 还需切断反向 opener，防止子窗间接取得父窗原生桥。
          if (!child.isDestroyed() && child.webContents.getURL() === PREVIEW_URL)
            void child.webContents.executeJavaScript("window.opener = null").catch(() => undefined);
        });
        void child.webContents.setVisualZoomLevelLimits(1, 1);
        const close = () => {
          if (!child.isDestroyed()) child.close();
        };
        parent.once("closed", close);
        child.once("closed", () => {
          children.delete(child);
          updateThrottling();
          parent.removeListener("closed", close);
        });
        return child.webContents;
      },
    };
  });
}
