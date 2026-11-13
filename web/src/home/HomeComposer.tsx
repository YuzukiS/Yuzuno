import { forwardRef, useRef } from "react";
import { PastedTextComposer, type ComposerHandle } from "../PastedTextComposer";
import { useDevicePreferences } from "../device-preferences";
import { draftText, type ComposerDraft } from "../composer-draft";
import { draftFromTextBlocks, draftTextBlocks, type TextBlock } from "../message-content";

/**
 * A reply's words as Home keeps them (YN-91): the whole text, as it is sent,
 * and where each paste block is in it, as the conversation marks pastes on a
 * message (`draftTextBlocks`). Without blocks it is plain text, as replies
 * kept before this were.
 */
export type ReplyWords = { text: string; blocks?: TextBlock[] };

export function replyWords(draft: ComposerDraft): ReplyWords {
  const blocks = draftTextBlocks(draft);
  return { text: draftText(draft), ...(blocks.length ? { blocks } : {}) };
}

const sameWords = (a: ReplyWords, b: ReplyWords) =>
  a.text === b.text && JSON.stringify(a.blocks ?? []) === JSON.stringify(b.blocks ?? []);

/**
 * The field Home's replies are written in (YN-91): the conversation's own
 * composer, so a long paste folds into a block that opens to be read, edited
 * or removed, and the words go out whole. Return sends as this device sends
 * from the conversation; Escape, in the field itself, is the reply's own.
 * For a card's reply, an Ask's words and a reply to a project alike, and for
 * any other place on Home that takes the user's words.
 */
export const HomeComposer = forwardRef<
  ComposerHandle,
  {
    /** Which reply it is: the editor keeps its undo history per reply. */
    slot: string;
    label: string;
    placeholder: string;
    words: ReplyWords;
    onWords: (words: ReplyWords) => void;
    onSubmit: () => void;
    readOnly?: boolean;
    onEscape?: () => void;
    /** More attributes of the field itself (PastedTextComposer). */
    attributes?: Record<string, string>;
  }
>(function HomeComposer({ slot, label, placeholder, words, onWords, onSubmit, readOnly = false, onEscape, attributes }, ref) {
  const { sendKey } = useDevicePreferences();
  // The editor's own draft while the words are the ones it wrote, so it keeps
  // its blocks, numbers and cursor; words changed elsewhere (sent, written in
  // another place this reply shows) are drawn afresh.
  const kept = useRef<{ words: ReplyWords; draft: ComposerDraft } | null>(null);
  if (!kept.current || !sameWords(kept.current.words, words))
    kept.current = { words, draft: draftFromTextBlocks(words.text, words.blocks) };
  return (
    <div
      className="home-composer"
      data-readonly={readOnly ? "" : undefined}
      onKeyDown={(event) => {
        // Not a block's dialog (a portal: in React's tree, not this one's), nor a tip the editor closed, nor an
        // input method's own Escape, which ends its composition (isComposing, or Safari's 229).
        if (event.key !== "Escape" || !onEscape || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        onEscape();
      }}
    >
      <PastedTextComposer
        ref={ref}
        agentId={slot}
        label={label}
        placeholder={placeholder}
        draft={kept.current.draft}
        readOnly={readOnly}
        slashCommands={false}
        sendKey={sendKey}
        attributes={attributes}
        onSubmit={onSubmit}
        onChange={(draft) => {
          const next = replyWords(draft);
          kept.current = { words: next, draft };
          onWords(next);
        }}
      />
    </div>
  );
});
