type OAuthCallback = (url: string) => void | Promise<void>;

export function createOAuthCallbackHandler(callback: OAuthCallback, notifyHandled: () => void) {
  return async (_event: unknown, url: string): Promise<void> => {
    try {
      await callback(url);
    } catch {
      // preload 只负责桥接 OAuth 回调与主进程握手，不能把 renderer 回调异常继续外抛成未处理 rejection。
      // 业务错误由 renderer 自己展示；这里无论成功失败都必须保证 handled 回执发回 main。
    } finally {
      notifyHandled();
    }
  };
}
