export interface BrowserWindowForTransparentBootstrap {
  isDestroyed(): boolean;
  isVisible?(): boolean;
  isMinimized?(): boolean;
  isFocused?(): boolean;
  getOpacity?(): number;
  setOpacity?(opacity: number): void;
  showInactive?(): void;
  hide?(): void;
  setSkipTaskbar?(skip: boolean): void;
  on?(event: "focus", listener: () => void): void;
  removeListener?(event: "focus", listener: () => void): void;
}

export interface TransparentWindowBootstrap {
  release(): void;
}

/**
 * showInactive 后 Viz surface 建立前的有界 presentation grace：同 turn 读回会抛
 * UnknownVizError（并发时曾 SIGSEGV）。所有"刚 showInactive 就要 capture"的路径
 * （activity pump、整幅 capture）都必须遵守同一常量。
 */
export const TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS = 100;

/**
 * 为 macOS hide-close 后才创建的 guest 提供一次对用户不可见的窗口级 presentation。
 *
 * 返回 undefined 表示不需要 bootstrap，false 表示当前窗口无法安全 bootstrap。
 */
export function startBrowserScreenshotTransparentWindowBootstrap(options: {
  win: BrowserWindowForTransparentBootstrap;
  enabled: boolean;
  windowId: number;
  webContentsId: number;
  requestId: string;
  hideTaskbarDuringBootstrap?: boolean;
  log?(message: string): void;
}): TransparentWindowBootstrap | false | undefined {
  const { win } = options;
  if (!options.enabled || win.isVisible?.() !== false || win.isMinimized?.() === true) {
    return undefined;
  }
  if (
    !win.isFocused ||
    !win.getOpacity ||
    !win.setOpacity ||
    !win.showInactive ||
    !win.hide ||
    !win.on ||
    !win.removeListener ||
    (options.hideTaskbarDuringBootstrap && !win.setSkipTaskbar)
  ) {
    options.log?.(
      `[browser-screenshot-activity] transparent bootstrap unavailable windowId=${options.windowId} webContentsId=${options.webContentsId} requestId=${options.requestId}`,
    );
    return false;
  }

  let originalOpacity: number;
  try {
    originalOpacity = win.getOpacity();
  } catch {
    options.log?.(
      `[browser-screenshot-activity] transparent bootstrap opacity read failed windowId=${options.windowId}`,
    );
    return false;
  }

  let released = false;
  let taskbarHidden = false;
  const release = (preserveVisibility: boolean) => {
    if (released) return;
    released = true;
    try {
      win.removeListener?.("focus", handleFocus);
    } catch {
      options.log?.(
        `[browser-screenshot-activity] transparent bootstrap listener cleanup failed windowId=${options.windowId}`,
      );
    }
    if (win.isDestroyed()) return;

    try {
      if (!preserveVisibility && !win.isFocused?.()) {
        win.hide?.();
      }
    } catch {
      options.log?.(
        `[browser-screenshot-activity] transparent bootstrap hide failed windowId=${options.windowId}`,
      );
    } finally {
      if (!win.isDestroyed()) {
        try {
          win.setOpacity?.(originalOpacity);
        } catch {
          options.log?.(
            `[browser-screenshot-activity] transparent bootstrap opacity restore failed windowId=${options.windowId}`,
          );
        }
        if (taskbarHidden) {
          try {
            win.setSkipTaskbar?.(false);
          } catch {
            options.log?.(
              `[browser-screenshot-activity] transparent bootstrap taskbar restore failed windowId=${options.windowId}`,
            );
          }
        }
      }
    }
  };
  const handleFocus = () => {
    // 透明 bootstrap 与用户从 Dock/second-instance 主动恢复窗口可能竞争。
    // focus 表示窗口所有权已回到用户；这里只恢复透明度，后续 Ready/release 禁止再次 hide。
    release(true);
  };

  try {
    // owner hidden 后才 attach 的 guest 从未获得 compositor 首帧；capturer count
    // 只能维持已有 surface。必须先透明再 showInactive，给 guest 一次不可见的 presentation
    // opportunity，并在 Ready/release 时恢复原窗口状态。
    if (options.hideTaskbarDuringBootstrap) {
      win.setSkipTaskbar?.(true);
      taskbarHidden = true;
    }
    win.setOpacity(0);
    win.on("focus", handleFocus);
    win.showInactive();
  } catch {
    release(true);
    options.log?.(
      `[browser-screenshot-activity] transparent bootstrap failed windowId=${options.windowId} webContentsId=${options.webContentsId} requestId=${options.requestId}`,
    );
    return false;
  }

  return { release: () => release(false) };
}
