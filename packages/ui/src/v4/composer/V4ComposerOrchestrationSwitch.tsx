// Modified by ZCode Feiyu contributors (2026).
import { memo, useId, useRef, useState } from "react";
import { ChevronDownIcon, NetworkIcon } from "lucide-react";
import {
  DEFAULT_ORCHESTRATION_STATE,
  type OrchestrationMode,
  type OrchestrationState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  TID_CHAT_ORCHESTRATION_SELECT_ITEM,
  TID_CHAT_ORCHESTRATION_SELECT_TRIGGER,
  TID_V4_COMPOSER,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isCoarseTouchDevice, resolveOwnComposerInput } from "@/lib/pickerFocus.js";
import type { V4ComposerConfigPicker } from "./configPickerState.js";

const MODES: readonly OrchestrationMode[] = ["standard", "coordinator", "swarm"];

export const V4ComposerOrchestrationSwitch = memo(function V4ComposerOrchestrationSwitch({
  state = DEFAULT_ORCHESTRATION_STATE,
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSetMode,
}: {
  state?: OrchestrationState;
  disabled: boolean;
  activeConfigPicker: V4ComposerConfigPicker | null;
  onConfigPickerOpenChange: (picker: V4ComposerConfigPicker, open: boolean) => void;
  onSetMode: (mode: OrchestrationMode) => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = (mode: OrchestrationMode) =>
    intl.formatMessage({ id: `chat.orchestration.${mode}` });
  const pending = state.requested !== state.effective;
  const hint = pending
    ? intl.formatMessage({ id: "chat.orchestration.pending" })
    : intl.formatMessage({ id: "chat.orchestration.label" });
  return (
    <DropdownMenu
      open={activeConfigPicker === "orchestration"}
      onOpenChange={(open) => onConfigPickerOpenChange("orchestration", open)}
    >
      <ControlHintTooltip
        title={error ?? hint}
        open={activeConfigPicker === "orchestration" ? false : undefined}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || submitting}
            data-testid={TID_CHAT_ORCHESTRATION_SELECT_TRIGGER}
            data-composer-collapse-priority="1"
            ref={triggerRef}
            aria-describedby={error ? errorId : undefined}
            aria-label={`${hint}: ${label(state.requested)}`}
            className="group/orchestration h-7 gap-1 rounded-lg px-2 text-ui-base data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0"
          >
            <NetworkIcon className="size-4" />
            <span className="inline group-data-[composer-compact=true]/orchestration:hidden">
              {label(state.requested)}
              {pending ? ` · ${intl.formatMessage({ id: "chat.orchestration.pendingShort" })}` : ""}
            </span>
            <ChevronDownIcon className="size-3.5 group-data-[composer-compact=true]/orchestration:hidden" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent
        side="top"
        sideOffset={4}
        className="w-64"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!isCoarseTouchDevice()) {
            // 多个会话窗格并存时，焦点只回到触发器所属窗格的输入框；找不到就留在触发器上。
            const input = resolveOwnComposerInput(
              triggerRef.current,
              `[data-testid="${TID_V4_COMPOSER}"]`,
              `[data-testid="${TID_V4_COMPOSER_INPUT}"]`,
            );
            (input ?? triggerRef.current)?.focus();
          }
        }}
      >
        <DropdownMenuRadioGroup
          value={state.requested}
          onValueChange={(value) => {
            if (!MODES.includes(value as OrchestrationMode)) return;
            setSubmitting(true);
            setError(null);
            // 失败只显示回执错误，不乐观改 requested/effective；下一帧继续读 V4 权威模式。
            void Promise.resolve()
              .then(() => onSetMode(value as OrchestrationMode))
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : String(cause));
              })
              .finally(() => {
                setSubmitting(false);
              });
          }}
        >
          {MODES.map((mode) => (
            <DropdownMenuRadioItem
              key={mode}
              value={mode}
              data-testid={testId(TID_CHAT_ORCHESTRATION_SELECT_ITEM, mode)}
              className="min-h-13 items-start gap-3 py-2"
            >
              <NetworkIcon className="mt-0.5 size-4.5 shrink-0" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>{label(mode)}</span>
                <span className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: `chat.orchestration.${mode}.description` })}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
      {error ? (
        <span
          id={errorId}
          role="alert"
          className="max-w-64 break-words text-ui-sm text-destructive"
        >
          {error}
        </span>
      ) : null}
    </DropdownMenu>
  );
});
