// Modified by ZCode Feiyu.
import { useCallback, useEffect, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $addUpdateTag,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  COMMAND_PRIORITY_LOW,
  HISTORY_PUSH_TAG,
  KEY_TAB_COMMAND,
} from "lexical";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { canAcceptSuggestedPrompt } from "./suggestedPromptInput.js";

export interface ComposerSuggestedPrompt {
  id: string;
  text: string;
}

/** 候选层不属于 Lexical 正文；唯一写入发生在明确采纳时。 */
export function SuggestedPromptPlugin({
  candidate,
  disabled,
  onVisibilityChange,
}: {
  candidate?: ComposerSuggestedPrompt;
  disabled: boolean;
  onVisibilityChange: (visible: boolean) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const { intl } = useZCodeIntl();
  const [empty, setEmpty] = useState(true);
  const [composing, setComposing] = useState(false);
  const [consumedId, setConsumedId] = useState<string | null>(null);
  const visible =
    Boolean(candidate?.text) && !disabled && empty && !composing && consumedId !== candidate?.id;
  useEffect(() => {
    onVisibilityChange(visible);
    return () => onVisibilityChange(false);
  }, [visible, onVisibilityChange]);
  useEffect(() => {
    const update = () =>
      editor.getEditorState().read(() => setEmpty($getRoot().getTextContent().length === 0));
    update();
    return editor.registerUpdateListener(update);
  }, [editor]);
  useEffect(() => {
    const start = () => setComposing(true);
    const end = () => setComposing(false);
    const unregister = editor.registerRootListener((root, previous) => {
      previous?.removeEventListener("compositionstart", start);
      previous?.removeEventListener("compositionend", end);
      root?.addEventListener("compositionstart", start);
      root?.addEventListener("compositionend", end);
    });
    return () => {
      unregister();
      editor.getRootElement()?.removeEventListener("compositionstart", start);
      editor.getRootElement()?.removeEventListener("compositionend", end);
    };
  }, [editor]);
  const accept = useCallback(
    (event?: KeyboardEvent) => {
      const root = editor.getRootElement();
      if (
        !canAcceptSuggestedPrompt({
          text: $getRoot().getTextContent(),
          suggestion: candidate?.text,
          enabled: visible,
          focused: event ? root === root?.ownerDocument.activeElement : true,
          composing: composing || editor.isComposing() || Boolean(event?.isComposing),
          defaultPrevented: event?.defaultPrevented,
          shiftKey: event?.shiftKey,
          altKey: event?.altKey,
          ctrlKey: event?.ctrlKey,
          metaKey: event?.metaKey,
        }) ||
        !candidate
      )
        return false;
      event?.preventDefault();
      // 单次 history push 保证撤销回空草稿；已采纳标记防止撤销后立即重复浮现。
      $addUpdateTag(HISTORY_PUSH_TAG);
      const paragraph = $createParagraphNode().append($createTextNode(candidate.text));
      $getRoot().clear().append(paragraph);
      paragraph.selectEnd();
      setConsumedId(candidate.id);
      return true;
    },
    [candidate, composing, editor, visible],
  );
  useEffect(
    () => editor.registerCommand(KEY_TAB_COMMAND, accept, COMMAND_PRIORITY_LOW),
    [editor, accept],
  );
  if (!visible || !candidate) return null;
  return (
    <>
      <div
        data-testid="suggested-prompt-ghost"
        className="pointer-events-none absolute inset-x-0 top-0 line-clamp-2 whitespace-pre-wrap break-words text-ui-base leading-relaxed text-foreground-subtlest opacity-60"
        aria-hidden="true"
      >
        {candidate.text}
      </div>
      <div className="flex min-h-5 justify-end pt-1 text-ui-caption text-foreground-subtlest">
        <button
          type="button"
          data-testid="suggested-prompt-accept"
          className="rounded px-1 hover:text-foreground focus-visible:outline"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            editor.update(() => accept(), { tag: HISTORY_PUSH_TAG, discrete: true });
            editor.focus();
          }}
          aria-label={intl.formatMessage({ id: "suggestedPrompt.accept" })}
        >
          {intl.formatMessage({ id: "suggestedPrompt.tabHint" })}
        </button>
      </div>
    </>
  );
}
