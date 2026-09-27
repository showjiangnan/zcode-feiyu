interface DarwinCloseAwareWindow {
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  hide(): void;
}

export function handleDarwinWindowCloseRequest(options: {
  win: DarwinCloseAwareWindow;
  forceQuit: boolean;
  label: string;
  logger: { info: (...args: unknown[]) => void };
}): boolean {
  if (options.forceQuit) {
    return false;
  }

  if (options.win.isFullScreen()) {
    // macOS 原生全屏会占用独立 Space，之前这里仍然沿用“点红点=隐藏窗口”。
    // 全屏态下直接 hide() 会把窗口藏进全屏 Space，用户看到的就是黑屏，但窗口其实没真正关闭。
    // 这里改成先退出全屏，让“点关闭”在全屏场景下退回普通窗口，避免留下黑屏 Space。
    options.win.setFullScreen(false);
    options.logger.info(
      `[createWindow] fullscreen close converted to leave-full-screen (${options.label})`,
    );
    return true;
  }

  options.win.hide();
  options.logger.info(`[createWindow] window hidden instead of closed (${options.label})`);
  return true;
}
