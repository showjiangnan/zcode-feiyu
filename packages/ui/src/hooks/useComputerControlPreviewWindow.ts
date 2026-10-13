// Modified by ZCode Feiyu.
import { useCallback, useEffect, useRef, useState } from "react";
import { usePlatform } from "./usePlatform.js";

export function useComputerControlPreviewWindow() {
  const platform = usePlatform();
  const [window, setWindow] = useState<Window | null>(null);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  const current = useRef<Window | null>(null);
  const open = useCallback(async () => {
    if (current.current && !current.current.closed) {
      current.current.focus();
      return;
    }
    try {
      const child = (await platform.openComputerControlPreview?.()) as Window | null | undefined;
      if (child && !mounted.current) {
        child.close();
        return;
      }
      if (!child) throw new Error("Preview window unavailable");
      current.current = child;
      child.opener = null;
      child.document.title = "ZCode";
      const base = child.document.createElement("base");
      base.href = document.baseURI;
      child.document.head.append(base);
      child.document.body.style.margin = "0";
      child.document.body.style.minHeight = "100vh";
      // 同一 renderer 的投影共享组件/主题；子窗不持有凭据或服务客户端。
      for (const style of document.querySelectorAll("style, link[rel='stylesheet']"))
        child.document.head.append(style.cloneNode(true));
      const theme = () => {
        child.document.documentElement.className = document.documentElement.className;
        child.document.documentElement.style.cssText = document.documentElement.style.cssText;
        child.document.documentElement.lang = document.documentElement.lang;
        child.document.documentElement.dataset.theme = document.documentElement.dataset.theme || "";
      };
      theme();
      const observer = new MutationObserver(theme);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style", "lang", "data-theme"],
      });
      child.addEventListener(
        "pagehide",
        () => {
          observer.disconnect();
          if (current.current === child) {
            current.current = null;
            if (mounted.current) setWindow(null);
          }
        },
        { once: true },
      );
      const visibility = () => {
        if (mounted.current) setVisible(child.document.visibilityState !== "hidden");
      };
      child.document.addEventListener("visibilitychange", visibility);
      child.addEventListener(
        "pagehide",
        () => child.document.removeEventListener("visibilitychange", visibility),
        { once: true },
      );
      visibility();
      setError(undefined);
      setWindow(child);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [platform]);
  const close = useCallback(() => {
    current.current?.close();
    current.current = null;
    setWindow(null);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.current?.close();
    };
  }, []);
  return {
    window,
    visible,
    open,
    close,
    error,
    supported: Boolean(platform.openComputerControlPreview),
  };
}
