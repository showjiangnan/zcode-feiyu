// Modified by ZCode Feiyu.
import { useRef, type RefObject, type Dispatch, type SetStateAction } from "react";
import { Move } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type Offset = { x: number; y: number };
export function ComputerControlPreviewMove({
  panel,
  offset,
  setOffset,
  hidden,
}: {
  panel: RefObject<HTMLElement | null>;
  offset: Offset;
  setOffset: Dispatch<SetStateAction<Offset>>;
  hidden: boolean;
}) {
  const { intl } = useZCodeIntl();
  const message = (id: string) => intl.formatMessage({ id: `computerControl.${id}` });
  const drag = useRef<{ x: number; y: number; originX: number; originY: number } | undefined>(
    undefined,
  );
  return (
    <button
      type="button"
      aria-label={message("move")}
      hidden={hidden}
      className="cursor-move touch-none text-foreground-subtle focus-visible:ring-2 focus-visible:ring-ring"
      onPointerDown={(event) => {
        drag.current = {
          x: event.clientX,
          y: event.clientY,
          originX: offset.x,
          originY: offset.y,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current || !panel.current?.parentElement) return;
        const parent = panel.current.parentElement.getBoundingClientRect();
        const rect = panel.current.getBoundingClientRect();
        const x = drag.current.originX + event.clientX - drag.current.x;
        const y = drag.current.originY + event.clientY - drag.current.y;
        setOffset({
          x: Math.min(0, Math.max(-parent.width + rect.width + 24, x)),
          y: Math.min(0, Math.max(-parent.height + rect.height + 120, y)),
        });
      }}
      onPointerUp={() => {
        drag.current = undefined;
      }}
      onPointerCancel={() => {
        drag.current = undefined;
      }}
      onKeyDown={(event) => {
        const delta = {
          ArrowLeft: [-10, 0],
          ArrowRight: [10, 0],
          ArrowUp: [0, -10],
          ArrowDown: [0, 10],
        }[event.key];
        if (delta) {
          event.preventDefault();
          const owner = panel.current?.parentElement;
          const frame = panel.current?.getBoundingClientRect();
          if (!owner || !frame) return;
          const parent = owner.getBoundingClientRect();
          setOffset((value) => ({
            x: Math.min(0, Math.max(parent.left - frame.left + value.x, value.x + delta[0]!)),
            y: Math.min(0, Math.max(parent.top - frame.top + value.y, value.y + delta[1]!)),
          }));
        }
      }}
    >
      <Move className="size-4" />
    </button>
  );
}
