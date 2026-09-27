interface BrowserOperationResultLike {
  ok?: unknown;
  meta?: unknown;
  tab?: unknown;
}

/**
 * 只有模型明确打开、显示、激活或改变 viewport 的命令才能重建 renderer 尺寸基线。
 * 普通 navigate/locator/screenshot 命令必须返回 false，否则会吞掉同一操作周期内真正的用户 resize。
 */
export function browserOperationResetsResizeBaseline(command: unknown): boolean {
  if (!command || typeof command !== "object") return false;
  const method = Reflect.get(command, "method");
  if (method === "browserVisibilitySet") return Reflect.get(command, "visible") === true;
  return ["activateTab", "browserViewportReset", "browserViewportSet", "newTab"].includes(
    String(method),
  );
}

function readTabId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const tabId = Reflect.get(value, "tabId");
  return typeof tabId === "string" && tabId.length > 0 ? tabId : undefined;
}

/**
 * browser command 开始时优先使用显式 tabId；没有显式 tabId 的 new/default-tab 调用，
 * 只能在成功结果里读取 manager 已解析的真实 tab identity，禁止 UI 自行猜测。
 */
export function resolveBrowserOperationTabId(
  command: unknown,
  result?: BrowserOperationResultLike,
): string | undefined {
  const requestedTabId = readTabId(command);
  if (requestedTabId) return requestedTabId;
  if (result?.ok !== true) return undefined;
  return readTabId(result.meta) ?? readTabId(result.tab);
}
