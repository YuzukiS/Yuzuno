import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ImagePlus, SquareDashedMousePointer } from "lucide-react";
import { PastedTextComposer, type ComposerHandle } from "../PastedTextComposer";
import { ComposerAddMenu, type ComposerAddItem } from "../ComposerAddMenu";
import { ImageAttachments } from "../ImageAttachments";
import { PointFix, type PointFixInto } from "../PointFix";
import type { PointFixSource } from "../point-fix";
import { clipboardImages, MAX_IMAGES, MAX_IMAGE_TOTAL } from "../image-input";
import { useDevicePreferences, type SendKey } from "../device-preferences";
import { draftText, type ComposerDraft } from "../composer-draft";
import { draftFromTextBlocks, draftTextBlocks, type TextBlock } from "../message-content";
import { strings, useLanguage, useStrings } from "../i18n";
import { shellText } from "../shell-text";
import { TipText } from "../Tip";
import { homeImageUrl, sameImages, useHomeImages, type HomeImage } from "./home-images";

/**
 * A reply's words as Home keeps them (YN-91): the whole text, as it is sent,
 * and where each paste block is in it, as the conversation marks pastes on a
 * message (`draftTextBlocks`). Without blocks it is plain text, as replies
 * kept before this were. With the images the user attached (YN-134), saved
 * to the Project's images, when its field takes them (`attach`).
 */
export type ReplyWords = { text: string; blocks?: TextBlock[]; images?: HomeImage[] };

export function replyWords(draft: ComposerDraft): ReplyWords {
  const blocks = draftTextBlocks(draft);
  return { text: draftText(draft), ...(blocks.length ? { blocks } : {}) };
}

const sameWords = (a: ReplyWords, b: ReplyWords) =>
  a.text === b.text && JSON.stringify(a.blocks ?? []) === JSON.stringify(b.blocks ?? []) && sameImages(a.images, b.images);

/** `words` with these images, and without the field when there are none. */
function withImages(words: ReplyWords, images: readonly HomeImage[]): ReplyWords {
  const rest = { ...words };
  delete rest.images;
  return images.length ? { ...rest, images: [...images] } : rest;
}

/** The field's handle: its editor's, and Point & Fix on an image to add to it (YN-134), when it takes images. */
export type HomeComposerHandle = ComposerHandle & { markUp?: (image: { id: string; name?: string }, provenance: string) => void };

/** Where a field's images go (YN-134): the Project's images, and why the message can't take them now. */
export type HomeAttach = {
  projectId: string;
  /** Why who the message goes to can't take images, when the page knows it; shown, with images, under them. */
  refusal?: string | null;
};

const text = strings({
  full: (n: number) => `This message already has ${n} images, and a message takes at most ${MAX_IMAGES}.`,
  tooLarge: "This message can't take these images: a message takes at most 40 MiB of images.",
}, {
  full: (n) => `这条消息已经有 ${n} 张图片，一条消息最多 ${MAX_IMAGES} 张。`,
  tooLarge: "这条消息放不下这些图片：一条消息的图片合计最多 40 MiB。",
});
// Point & Fix writes these into the notes for the Agent, in English, as the conversation does (App.tsx).
const PASTED = "Pasted image";
export const attachedImage = (name: string) => `the image ${name} you attached`;
const chosenImage = (name: string) => `an image you chose (${name})`;

/**
 * The field Home's replies are written in (YN-91): the conversation's own
 * composer, so a long paste folds into a block that opens to be read, edited
 * or removed, and the words go out whole. Return sends as this device sends
 * from the conversation; Escape, in the field itself, is the reply's own.
 * For a card's reply, an Ask's words and a reply to a project alike, and for
 * any other place on Home that takes the user's words.
 *
 * With `attach` (YN-134) it takes images as the conversation's composer
 * does: "+" (add images, mark up an image), paste and drop, thumbnails under
 * the text to open, mark up or remove, saved to the Project's images; its
 * own Point & Fix adds to it. Without, it looks and behaves as before.
 */
export const HomeComposer = forwardRef<
  HomeComposerHandle,
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
    /** Which key sends from this field (YN-106): a form's field that edits
     * text makes Return a new line (`modEnter`). Unset, as this device sends
     * from the conversation. */
    sendKey?: SendKey;
    /** Takes images, saved to this Project's images (YN-134). */
    attach?: HomeAttach;
    /** Whether its images are being saved: nothing is sent until they are. */
    onUploading?: (busy: boolean) => void;
  }
>(function HomeComposer(
  { slot, label, placeholder, words, onWords, onSubmit, readOnly = false, onEscape, attributes, sendKey: fieldKey, attach, onUploading },
  ref,
) {
  const { sendKey: deviceKey } = useDevicePreferences();
  const sendKey = fieldKey ?? deviceKey;
  const language = useLanguage();
  const shell = shellText(language);
  const t = useStrings(text);
  const editor = useRef<ComposerHandle>(null);
  // The editor's own draft while the words are the ones it wrote, so it keeps
  // its blocks, numbers and cursor; words changed elsewhere (sent, written in
  // another place this reply shows) are drawn afresh.
  const kept = useRef<{ words: ReplyWords; draft: ComposerDraft } | null>(null);
  if (!kept.current || !sameWords(kept.current.words, words))
    kept.current = { words, draft: draftFromTextBlocks(words.text, words.blocks) };
  const emit = (next: ReplyWords) => {
    kept.current = { words: next, draft: kept.current!.draft };
    onWords(next);
  };
  const current = () => kept.current?.words.images ?? [];

  const uploads = useHomeImages(attach?.projectId ?? "");
  const busy = uploads.busy(slot);
  useEffect(() => {
    onUploading?.(busy);
    // Told when it changes; the callback is the caller's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  const add = (files: readonly File[]) => {
    if (!attach || readOnly) return;
    void uploads.add(slot, files, current, (image) => {
      if (!current().some((saved) => saved.id === image.id)) emit(withImages(kept.current!.words, [...current(), image]));
    });
  };
  const remove = (id: string) => emit(withImages(kept.current!.words, current().filter((image) => image.id !== id)));

  const [pointFix, setPointFix] = useState<PointFixSource | null>(null);
  const imagePicker = useRef<HTMLInputElement>(null);
  const pointFixPicker = useRef<HTMLInputElement>(null);
  function markUp(image: { id: string; name?: string }, provenance: string) {
    if (!attach || readOnly) return;
    const name = image.name || PASTED;
    setPointFix({
      name,
      ownerId: null,
      provenance,
      inDraft: { agentId: "", id: image.id },
      load: async (signal) => {
        const response = await fetch(homeImageUrl(attach.projectId, image.id), { signal });
        if (!response.ok) throw new Error(`the saved image is unavailable (HTTP ${response.status})`);
        return response.blob();
      },
    });
  }
  const room = (images: readonly { bytes: number }[]) => {
    const now = current();
    if (now.length + images.length > MAX_IMAGES) return t.full(now.length);
    if (now.reduce((n, i) => n + i.bytes, 0) + images.reduce((n, i) => n + i.bytes, 0) > MAX_IMAGE_TOTAL) return t.tooLarge;
    return null;
  };
  // Point & Fix ends here, as it does in an Agent's draft (App.tsx addPointFix): the notes after the
  // text, then the annotated image and the original, if it was not here, after the images.
  const into: PointFixInto | null = attach
    ? {
        label,
        room,
        upload: uploads.upload,
        add: (images, notes) => {
          const fresh = images.filter((image) => !current().some((saved) => saved.id === image.id));
          const full = room(fresh);
          if (full) return full;
          editor.current?.append(notes);
          emit(withImages(kept.current!.words, [...current(), ...fresh]));
          requestAnimationFrame(() => editor.current?.focusEnd());
          return null;
        },
        position: (id) => current().findIndex((image) => image.id === id) + 1,
      }
    : null;

  useImperativeHandle(ref, () => ({
    focus: (options) => editor.current?.focus(options),
    focusEnd: () => editor.current?.focusEnd(),
    append: (more) => editor.current?.append(more),
    lineExtent: () => editor.current?.lineExtent() ?? null,
    rows: () => editor.current?.rows() ?? 0,
    ...(attach ? { markUp } : {}),
  }));

  const images = words.images ?? [];
  const error = attach ? uploads.error(slot) : "";
  const items: ComposerAddItem[] = attach
    ? [
        {
          key: "images",
          label: busy ? shell.savingImages : shell.addImages,
          icon: <ImagePlus size={16} />,
          tip: <TipText body={shell.imageRules} />,
          disabled: busy,
          onSelect: () => imagePicker.current?.click(),
        },
        {
          key: "markUp",
          label: shell.markUp,
          icon: <SquareDashedMousePointer size={16} />,
          tip: <TipText title="Point & Fix" body={shell.markUpBody} />,
          onSelect: () => pointFixPicker.current?.click(),
        },
        // More go here (a file, YN-145 F7).
      ]
    : [];
  return (
    <div
      className="home-composer"
      data-readonly={readOnly ? "" : undefined}
      data-attach={attach ? "" : undefined}
      onKeyDown={(event) => {
        // Not a block's dialog (a portal: in React's tree, not this one's), nor a tip the editor closed, nor an
        // input method's own Escape, which ends its composition (isComposing, or Safari's 229).
        if (event.key !== "Escape" || !onEscape || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        onEscape();
      }}
      onDragOver={attach ? (event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      } : undefined}
      onDrop={attach ? (event) => {
        // Images dropped on the box go with the words, as pasted ones do; the editor takes those dropped on its text.
        if (event.defaultPrevented || !event.dataTransfer.types.includes("Files") || !event.currentTarget.contains(event.target as Node)) return;
        event.preventDefault();
        add(clipboardImages(event.dataTransfer));
      } : undefined}
    >
      <PastedTextComposer
        ref={editor}
        agentId={slot}
        label={label}
        placeholder={placeholder}
        draft={kept.current.draft}
        readOnly={readOnly}
        slashCommands={false}
        sendKey={sendKey}
        attributes={attributes}
        onSubmit={onSubmit}
        onImages={attach ? add : undefined}
        onChange={(draft) => emit(withImages(replyWords(draft), current()))}
      />
      {attach && (
        <>
          <ImageAttachments
            images={images}
            imageUrl={(id, thumb) => homeImageUrl(attach.projectId, id, thumb)}
            onRemove={readOnly ? undefined : remove}
            annotateThumbnails
            onAnnotate={readOnly ? undefined : (image) => markUp(image, attachedImage(image.name || PASTED))}
          />
          {error && <p className="inline-error home-composer-note" role="alert">{error}</p>}
          {images.length > 0 && attach.refusal && <p className="inline-error home-composer-note" role="status">{attach.refusal}</p>}
          {!readOnly && (
            <div className="home-composer-tools">
              <input ref={imagePicker} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden aria-label={shell.chooseImages}
                onChange={(event) => {
                  const files = Array.from(event.target.files || []);
                  event.target.value = "";
                  add(files);
                }} />
              <input ref={pointFixPicker} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label={shell.chooseToMark}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) setPointFix({ name: file.name || "Screenshot", ownerId: null, provenance: chosenImage(file.name || "pasted"), load: async () => file });
                }} />
              <ComposerAddMenu
                label={shell.addMenu}
                tip={<TipText title={shell.addMenuLabel} meta={[shell.addImages, shell.markUp]} />}
                menuLabel={shell.addMenuLabel}
                busy={busy}
                items={items}
              />
            </div>
          )}
          {into && <PointFix source={pointFix} into={into} onClose={() => setPointFix(null)} />}
        </>
      )}
    </div>
  );
});
