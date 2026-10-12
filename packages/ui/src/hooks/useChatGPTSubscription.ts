// Modified by ZCode Feiyu.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatGPTSubscriptionCommand, ChatGPTSubscriptionView } from "@zcode/shared";
import { useOptionalPlatform } from "./usePlatform.js";
import { useOptionalServices } from "./useServices.js";

const initial: ChatGPTSubscriptionView = {
  revision: 0,
  available: false,
  connection: null,
  pending: null,
};

/** Renderer 仅有脱敏展示状态，命令和凭据均归安装级 owner。 */
export function useChatGPTSubscription() {
  const platform = useOptionalPlatform(),
    services = useOptionalServices();
  const [view, setView] = useState(initial),
    [busy, setBusy] = useState(false);
  const revision = useRef(0),
    mounted = useRef(true),
    currentView = useRef(initial);
  const desktop = !!platform?.executeChatGPTSubscription;
  const execute = useCallback(
    async (command: ChatGPTSubscriptionCommand) => {
      const request = ++revision.current;
      if (command.type !== "read") setBusy(true);
      try {
        const next = platform?.executeChatGPTSubscription
          ? await platform.executeChatGPTSubscription(command)
          : services?.chatGPTSubscriptionService
            ? await services.chatGPTSubscriptionService.execute(command)
            : { ...initial, unavailableReason: "subscription_managed_host_required" };
        if (mounted.current && request === revision.current) {
          currentView.current = next;
          setView(next);
        }
        return next;
      } catch {
        // 临时 IPC/网络错误不能抹掉已验证连接和最后目录，更不能使 UI 冒充退出登录。
        const next = {
          ...currentView.current,
          error: { code: "subscription_service_unavailable" },
        };
        if (mounted.current && request === revision.current) setView(next);
        return next;
      } finally {
        if (mounted.current && command.type !== "read") setBusy(false);
      }
    },
    [platform, services?.chatGPTSubscriptionService],
  );
  useEffect(() => {
    mounted.current = true;
    void execute({ type: "read" });
    return () => {
      mounted.current = false;
      revision.current++;
    };
  }, [execute]);
  useEffect(() => {
    const timer = setInterval(
      () => {
        if (!busy) void execute({ type: "read" });
      },
      view.pending ? 750 : 15_000,
    );
    return () => clearInterval(timer);
  }, [execute, busy, view.pending]);
  return {
    view,
    busy,
    execute,
    desktop,
    openUsage: () => platform?.openExternal("https://chatgpt.com/settings/usage"),
  };
}
