// Modified by ZCode Feiyu contributors (2026).
import type { ComponentProps } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { SearchIcon } from "lucide-react";

export function QuickPickSearchField(props: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex h-8 items-center gap-2 rounded-full border border-input-border bg-input px-2.5 transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused">
      <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
      <CommandPrimitive.Input
        {...props}
        className="min-w-0 flex-1 bg-transparent text-ui-base leading-5 text-foreground outline-none placeholder:text-foreground-subtlest"
      />
    </div>
  );
}
