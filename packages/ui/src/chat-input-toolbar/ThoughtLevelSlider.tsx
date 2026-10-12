// Modified by ZCode Feiyu.
import { useId, type CSSProperties } from "react";
import type { ZCodeConfigOption, ZCodeProvider } from "@zcode/shared";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getThoughtLevelLabel, isMaximumThoughtLevel } from "./thoughtLevelOptions.js";

export function ThoughtLevelIndicator({
  option,
  provider,
  className,
}: {
  option: ZCodeConfigOption;
  provider?: ZCodeProvider;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const selected =
    option.type === "select"
      ? option.options?.find((entry) => entry.value === option.currentValue)
      : undefined;
  if (!selected) return null;
  return (
    <span
      data-testid="composer-thought-indicator"
      data-maximum={isMaximumThoughtLevel(selected.value) ? "true" : undefined}
      className={`composer-thought-indicator shrink-0 text-ui-caption text-foreground-subtlest ${className ?? ""}`}
    >
      {getThoughtLevelLabel(intl, provider, option, selected)}
    </span>
  );
}

/** 受控离散轨道只投影目录与 Composer 选择，不创建档位状态或第二条写入路径。 */
export function ThoughtLevelSlider({
  option,
  provider,
  disabled,
  shortcutLabel,
  onValueChange,
}: {
  option: ZCodeConfigOption;
  provider?: ZCodeProvider;
  disabled?: boolean;
  shortcutLabel?: string;
  onValueChange: (value: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const id = useId();
  const entries = option.type === "select" ? (option.options ?? []) : [];
  if (!entries.length) return null;
  const selectedIndex = entries.findIndex((entry) => entry.value === option.currentValue);
  const index = Math.max(0, selectedIndex);
  const selected = entries[selectedIndex];
  const label = intl.formatMessage({ id: "chat.toolbar.thoughtLevel.tooltip" });
  const valueLabel = selected
    ? getThoughtLevelLabel(intl, provider, option, selected)
    : intl.formatMessage({ id: "chat.toolbar.thoughtLevel.placeholder" });
  const fixed = entries.length === 1;
  const maximum = selected && isMaximumThoughtLevel(selected.value);
  const commitIndex = (next: number) => {
    const entry = entries[next];
    if (!disabled && !fixed && entry && entry.value !== option.currentValue)
      onValueChange(entry.value);
  };
  return (
    <section
      data-testid="composer-thought-slider-section"
      className="min-w-0 px-2 pb-2"
      aria-label={label}
    >
      <DropdownMenuSeparator className="mb-2" />
      <div className="mb-1 flex items-center gap-2 text-ui-caption">
        <label htmlFor={id} className="flex-1 text-foreground-subtle">
          {label}
        </label>
        <span
          className="composer-thought-indicator text-foreground-subtlest"
          data-maximum={maximum ? "true" : undefined}
        >
          {valueLabel}
        </span>
      </div>
      <div
        className="composer-reasoning-control relative h-8"
        data-maximum={maximum ? "true" : undefined}
        data-disabled={disabled || fixed ? "true" : undefined}
        style={
          {
            "--reasoning-progress": `${fixed ? 100 : (index / (entries.length - 1)) * 100}%`,
          } as CSSProperties
        }
      >
        <div className="composer-reasoning-rail" aria-hidden="true">
          <div className="composer-reasoning-fill" />
          <div className="composer-reasoning-ticks">
            {entries.map((entry) => (
              <span key={entry.value} />
            ))}
          </div>
        </div>
        <DropdownMenuItem
          asChild
          disabled={disabled || fixed}
          onSelect={(event) => event.preventDefault()}
        >
          <input
            id={id}
            type="range"
            role="slider"
            aria-label={label}
            aria-valuetext={valueLabel}
            min={0}
            max={Math.max(0, entries.length - 1)}
            step={1}
            value={index}
            disabled={disabled || fixed}
            className="composer-reasoning-slider"
            onChange={(event) => commitIndex(Number(event.currentTarget.value))}
            onKeyDown={(event) => {
              // Radix 的同节点 roving-focus 会消费 Home/End，仅 stopPropagation
              // 仍会阻止原生 range 改值。显式提交离散索引并 preventDefault，保留同一写入路径。
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? entries.length - 1
                    : ["ArrowRight", "ArrowUp"].includes(event.key)
                      ? Math.min(entries.length - 1, index + 1)
                      : ["ArrowLeft", "ArrowDown"].includes(event.key)
                        ? Math.max(0, index - 1)
                        : undefined;
              if (next !== undefined) {
                event.preventDefault();
                event.stopPropagation();
                commitIndex(next);
              } else if (event.key === "Tab") event.stopPropagation();
              // Escape 仍交给共享菜单恢复输入框焦点。
            }}
          />
        </DropdownMenuItem>
      </div>
      <div
        className="mt-1 flex justify-between gap-2 text-ui-xs text-foreground-subtlest"
        aria-hidden="true"
      >
        <span>{getThoughtLevelLabel(intl, provider, option, entries[0]!)}</span>
        {!fixed ? (
          <span>{getThoughtLevelLabel(intl, provider, option, entries.at(-1)!)}</span>
        ) : null}
      </div>
      {shortcutLabel ? (
        <p className="mt-1 text-ui-xs text-foreground-subtlest">{shortcutLabel}</p>
      ) : null}
    </section>
  );
}
