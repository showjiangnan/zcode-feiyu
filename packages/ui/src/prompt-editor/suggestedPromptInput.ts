// Modified by ZCode Feiyu.
/** 仅无修饰 Tab 采纳；不能抢 IME、菜单、用户快捷键或任何已有正文。 */
export function canAcceptSuggestedPrompt(input: {
  text: string;
  suggestion?: string;
  enabled: boolean;
  focused: boolean;
  composing: boolean;
  defaultPrevented?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): boolean {
  return (
    input.enabled &&
    Boolean(input.suggestion) &&
    input.text.length === 0 &&
    input.focused &&
    !input.composing &&
    !input.defaultPrevented &&
    !input.shiftKey &&
    !input.altKey &&
    !input.ctrlKey &&
    !input.metaKey
  );
}
