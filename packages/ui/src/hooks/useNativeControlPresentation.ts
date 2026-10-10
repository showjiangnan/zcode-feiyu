// Modified by ZCode Feiyu contributors (2026).
import { useEffect, useRef } from "react";
import type { ControlPresentation } from "@zcode/zcode-cua/control-contract";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function useNativeControlPresentation() {
  const { intl } = useZCodeIntl();
  const presentation = useRef<ControlPresentation | undefined>(undefined);
  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) return;
    const measure = document.createElement("span");
    measure.className = "text-ui-caption";
    measure.style.visibility = "hidden";
    measure.style.position = "absolute";
    measure.style.pointerEvents = "none";
    document.body.append(measure);
    const update = () => {
      const style = getComputedStyle(measure);
      const color = (token: string): [number, number, number, number] => {
        const value = style.getPropertyValue(token).trim();
        if (!CSS.supports("color", value))
          throw new Error("Native feedback requires a resolved UI color");
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data].map((number) => number / 255) as [
          number,
          number,
          number,
          number,
        ];
      };
      // 原生反馈消费当前 UI 的计算后语义 token；不复制另一套字号、颜色或语言配置。
      try {
        presentation.current = {
          captionSize: parseFloat(style.fontSize),
          foreground: color("--color-foreground"),
          background: color("--color-popover"),
          border: color("--color-popover-border"),
          accent: color("--color-brand"),
          labels: Object.fromEntries(
            ["observing", "active", "waiting", "paused"].map((phase) => [
              phase,
              intl.formatMessage({ id: `computerControl.native.${phase}` }),
            ]),
          ) as ControlPresentation["labels"],
        };
      } catch {
        presentation.current = undefined;
      }
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
    return () => {
      observer.disconnect();
      measure.remove();
    };
  }, [intl]);
  return presentation;
}
