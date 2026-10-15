// Modified by ZCode Feiyu.
import { useState } from "react";
import { ChevronDown, ChevronRight, Info } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Button } from "@/components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";

export interface ImportSelectionItem {
  key: string;
  label: string;
  caption: string;
  available: boolean;
  note?: string;
}
export function ImportSelectionGroup({
  title,
  items,
  selected,
  onChange,
}: {
  title: string;
  items: ImportSelectionItem[];
  selected: Set<string>;
  onChange: (keys: string[], checked: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const keys = items.filter((item) => item.available).map((item) => item.key);
  const count = keys.filter((key) => selected.has(key)).length;
  const checked = count === 0 ? false : count === keys.length ? true : "indeterminate";
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-3 p-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-w-0 flex-1 justify-start"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          <span className="truncate text-ui-base font-medium">{title}</span>
        </Button>
        <Checkbox
          aria-label={title}
          checked={checked}
          disabled={!keys.length}
          onCheckedChange={(value) => onChange(keys, value === true)}
        />
      </div>
      {expanded && (
        <div className="border-t border-border">
          {items.map((item) => (
            <div key={item.key} className="flex items-start gap-3 px-4 py-3">
              <label className="min-w-0 flex-1 cursor-pointer" htmlFor={`import-${item.key}`}>
                <span className="block text-ui-base font-medium">{item.label}</span>
                <span className="mt-1 block break-all text-ui-xs text-foreground-subtle">
                  {item.caption}
                </span>
                {!item.available && (
                  <span className="block text-ui-xs text-foreground-subtle">{item.note}</span>
                )}
              </label>
              {item.note && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${item.label}: ${item.note}`}
                    >
                      <Info className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs break-words text-ui-sm">
                    {item.note}
                  </TooltipContent>
                </Tooltip>
              )}
              <Checkbox
                id={`import-${item.key}`}
                className="mt-1"
                aria-label={item.label}
                checked={selected.has(item.key)}
                disabled={!item.available}
                onCheckedChange={(value) => onChange([item.key], value === true)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
