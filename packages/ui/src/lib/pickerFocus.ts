// Modified by ZCode Feiyu contributors (2026).
export function isCoarseTouchDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

export function shouldRestoreChatInputFocusAfterPickerClose({
  isCoarseTouchDevice: coarseTouch,
}: {
  isCoarseTouchDevice: boolean;
}): boolean {
  // 手机触控设备关闭工具栏弹层后，如果继续把焦点送回 contenteditable，
  // 系统软键盘会再次弹出并遮挡远控界面；桌面端仍保留关闭后继续输入的键盘流。
  return !coarseTouch;
}

/**
 * 菜单关闭后应交还焦点的输入框：只在触发器所属的 composer 内解析。
 *
 * 修复原因：曾用 `document.querySelector` 取整个文档里第一个同名输入框，多个会话窗格并存时
 * 在第二个窗格关闭菜单会把焦点送到第一个窗格（复审 DEF-23）。
 * 依据：焦点属于操作发生的窗格；找不到所属 composer 或输入框时返回 null，由调用方留在触发器上，
 * 绝不回落到全局查询。
 */
export function resolveOwnComposerInput(
  anchor: Pick<Element, "closest"> | null | undefined,
  composerSelector: string,
  inputSelector: string,
): HTMLElement | null {
  return anchor?.closest(composerSelector)?.querySelector<HTMLElement>(inputSelector) ?? null;
}
