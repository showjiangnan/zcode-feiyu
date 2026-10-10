// Modified by ZCode Feiyu contributors (2026).
import { cn } from "@/components/lib/utils.js";

export const quickPickDialogClassName =
  "top-1/2 max-w-lg -translate-y-1/2 overflow-hidden rounded-2xl! border-popover-border bg-popover p-0 shadow-md";

export const quickPickCommandClassName = "rounded-2xl bg-popover p-0.5 text-foreground";

export const quickPickListClassName = "max-h-[min(460px,64vh)] py-0.5";

// 全局搜索与项目搜索共用尺寸和顶部定位，防止通用 Dialog 的全宽默认值回归。
export const quickPickSearchDialogClassName = cn(
  quickPickDialogClassName,
  "w-[calc(100%-2rem)]",
  "top-16 max-h-[calc(100dvh-4.5rem)] -translate-y-0 sm:top-20 sm:max-h-[calc(100dvh-6rem)]",
  "platform-linux-desktop:top-16 sm:platform-linux-desktop:top-20",
);
export const quickPickSearchListClassName = cn(
  quickPickListClassName,
  "max-h-[min(440px,calc(100dvh-15rem))]",
);
export const quickPickSearchHeaderClassName = "border-b border-border px-2 pt-2 pb-2";

export const quickPickItemClassName = "min-h-8 items-center rounded-xl px-2.5 text-ui-base";

export const quickPickShortcutPillClassName =
  "inline-flex h-4 min-w-7 items-center justify-center rounded-sm bg-surface px-1 py-0 font-sans text-ui-base leading-none tracking-normal text-foreground-subtle";

export const quickPickMetadataClassName =
  "max-w-[45%] truncate font-sans text-ui-base leading-none tracking-normal text-foreground-subtle";
