import { parseConversationShareRoute } from "./conversationSharePreviewClient.js";

export function resolveConversationShareCodeFromPath(pathname: string): string | null {
  return parseConversationShareRoute(pathname);
}

/**
 * 中文站 /cn/share 与英文站 /share 都是分享路由。
 * 这里只判断「是否归分享页处理」，形状不合法的留给 code 解析报 invalid_contract。
 */
export function isConversationSharePath(pathname: string): boolean {
  return (
    pathname === "/cn/share" ||
    pathname.startsWith("/cn/share/") ||
    pathname === "/share" ||
    pathname.startsWith("/share/")
  );
}
