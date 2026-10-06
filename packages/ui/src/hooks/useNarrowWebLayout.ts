import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 767px)";
function subscribe(onChange: () => void) {
  const query = window.matchMedia(QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const snapshot = () => window.matchMedia(QUERY).matches;
const serverSnapshot = () => false;

/** 窄屏只改变共享界面的展示布局，桌面窗口继续使用原有分栏。 */
export function useNarrowWebLayout(isDesktop?: boolean) {
  const narrow = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return !isDesktop && narrow;
}
