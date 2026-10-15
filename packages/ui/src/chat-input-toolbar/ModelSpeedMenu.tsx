// Modified by ZCode Feiyu.
import { useId, type CSSProperties } from "react";
import type { ModelSpeed, ModelSpeedObservation } from "@zcode/shared";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ModelSpeedIcon } from "./ModelSpeedIcon.js";

/** 与思考级别共用轨道样式；只投影 Composer 的选择与 Host 许可档位。 */
export function ModelSpeedMenu({
  value,
  options,
  onChange,
  disabled,
  observation,
}: {
  value: ModelSpeed;
  options: readonly ModelSpeed[];
  onChange: (speed: ModelSpeed) => void;
  disabled?: boolean;
  observation?: ModelSpeedObservation;
}) {
  const { intl } = useZCodeIntl();
  const id = useId();
  const label = (speed: string) => intl.formatMessage({ id: `chat.modelSpeed.${speed}` });
  const index = Math.max(0, options.indexOf(value));
  const selected = options[index] ?? "standard";
  const progress = options.length > 1 ? (index / (options.length - 1)) * 100 : 0;
  const commit = (next: number) => {
    const speed = options[next];
    if (!disabled && speed && speed !== value) onChange(speed);
  };
  const actual =
    observation?.actualServiceTier === "priority"
      ? "fast"
      : observation?.actualServiceTier === "default"
        ? "standard"
        : (observation?.actualServiceTier ?? "unknown");
  return (
    <section
      data-testid="model-speed-menu"
      className="min-w-0 px-2 pb-2"
      aria-label={label("title")}
    >
      <DropdownMenuSeparator className="mb-2" />
      <div className="mb-1 flex items-center gap-2 text-ui-caption">
        <label htmlFor={id} className="flex-1 text-foreground-subtle">
          {label("title")}
        </label>
        <span className="text-foreground-subtlest">{label(selected)}</span>
      </div>
      <div
        className="composer-reasoning-control relative h-8"
        data-maximum={selected === "ultrafast" ? "true" : undefined}
        data-disabled={disabled ? "true" : undefined}
        style={{ "--reasoning-progress": `${progress}%` } as CSSProperties}
      >
        <div className="composer-reasoning-rail" aria-hidden="true">
          <div className="composer-reasoning-fill" />
          <div className="composer-reasoning-ticks">
            {options.map((speed) => (
              <span key={speed} />
            ))}
          </div>
        </div>
        <DropdownMenuItem asChild disabled={disabled} onSelect={(event) => event.preventDefault()}>
          <input
            id={id}
            type="range"
            role="slider"
            aria-label={label("title")}
            aria-valuetext={label(selected)}
            min={0}
            max={Math.max(0, options.length - 1)}
            step={1}
            value={index}
            disabled={disabled}
            className="composer-reasoning-slider"
            onChange={(event) => commit(Number(event.currentTarget.value))}
            onKeyDown={(event) => {
              // Radix roving-focus 消费 range 的方向键，显式提交离散索引保持菜单打开。
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? options.length - 1
                    : ["ArrowRight", "ArrowUp"].includes(event.key)
                      ? Math.min(options.length - 1, index + 1)
                      : ["ArrowLeft", "ArrowDown"].includes(event.key)
                        ? Math.max(0, index - 1)
                        : undefined;
              if (next !== undefined) {
                event.preventDefault();
                event.stopPropagation();
                commit(next);
              } else if (event.key === "Tab") event.stopPropagation();
            }}
          />
        </DropdownMenuItem>
        <span
          data-testid="model-speed-thumb-icon"
          className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 text-foreground"
          style={{ left: `calc(${progress}% + ${12 - progress * 0.24}px)` }}
        >
          <ModelSpeedIcon speed={selected} className="size-3.5" />
        </span>
      </div>
      <div
        className="mt-1 flex justify-between gap-2 text-ui-xs text-foreground-subtlest"
        aria-hidden="true"
      >
        {options.map((speed) => (
          <span key={speed} data-model-speed={speed}>
            {label(speed)}
          </span>
        ))}
      </div>
      <p className="mt-1 text-ui-xs text-foreground-subtle">{label("usage")}</p>
      {observation ? (
        <p data-testid="model-speed-actual" className="mt-1 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "chat.modelSpeed.actual" }, { speed: label(actual) })}
          {observation.downgraded ? ` · ${label("downgraded")}` : ""}
        </p>
      ) : null}
    </section>
  );
}
