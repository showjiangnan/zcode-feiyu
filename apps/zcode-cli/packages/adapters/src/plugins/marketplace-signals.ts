// Modified by ZCode Feiyu.
import {
  type MarketplaceOperationSignalScope,
  CLAUDE_OFFICIAL_MARKETPLACE,
  CLAUDE_MARKETPLACE_REFRESH_TIMEOUT_MS,
} from "./marketplace-types.js";

export function throwIfPluginOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createPluginOperationCancelledError();
  }
}

export function createPluginOperationCancelledError(): Error {
  const error = new Error("Plugin operation cancelled");
  error.name = "AbortError";
  return error;
}

export // Claude 官方市场只提供可选目录，外部网络不可达时必须中止底层请求，不能拖住其他插件市场。
function createMarketplaceOperationSignalScope(
  trustedId: string | undefined,
  externalSignal?: AbortSignal,
): MarketplaceOperationSignalScope {
  if (trustedId !== CLAUDE_OFFICIAL_MARKETPLACE) {
    return {
      cleanup: () => {},
      signal: externalSignal,
      timedOut: false,
      timeoutError: new Error("Marketplace operation timed out"),
    };
  }

  const controller = new AbortController();
  const timeoutError = new Error(
    `Claude marketplace refresh timed out after ${CLAUDE_MARKETPLACE_REFRESH_TIMEOUT_MS / 1000} seconds`,
  );
  timeoutError.name = "TimeoutError";
  const scope: MarketplaceOperationSignalScope = {
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortExternal);
    },
    signal: controller.signal,
    timedOut: false,
    timeoutError,
  };
  const abortExternal = (): void => {
    controller.abort(externalSignal?.reason);
  };
  const timeout = setTimeout(() => {
    scope.timedOut = true;
    controller.abort(timeoutError);
  }, CLAUDE_MARKETPLACE_REFRESH_TIMEOUT_MS);

  if (externalSignal?.aborted) {
    abortExternal();
  } else {
    externalSignal?.addEventListener("abort", abortExternal, { once: true });
  }
  return scope;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal?.aborted) {
      rejectDelay(createPluginOperationCancelledError());
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleAbort = (): void => {
      cleanup();
      rejectDelay(createPluginOperationCancelledError());
    };
    timeout = setTimeout(() => {
      cleanup();
      resolveDelay();
    }, ms);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}
