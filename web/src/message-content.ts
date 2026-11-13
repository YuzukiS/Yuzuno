import type { ComposerDraft, DraftPart } from "./composer-draft.ts";
import { pastedText, shouldFoldPaste, textDraft } from "./composer-draft.ts";
import type { NativeItem } from "./types.ts";

export type TextBlock = { id: string; start: number; end: number };
export type ContentPart =
  | { kind: "text"; text: string }
  | {
      kind: "paste" | "long";
      id: string;
      text: string;
      start: number;
      end: number;
    };
export type RequestPart =
  | { kind: "text"; text: string }
  | {
      kind: "paste" | "long";
      id: string;
      start: number;
      end: number;
      label: string;
      truncated?: boolean;
      preview: string;
    };

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Ten user-perceived characters; layout is adapted only in the label. */
export function textLabel(text: string) {
  let label = "",
    count = 0,
    end = 0;
  for (const part of segmenter.segment(text)) {
    if (count++ === 10) break;
    label += part.segment;
    end = part.index + part.segment.length;
  }
  return (
    label
      .replace(/\r\n|\r|\n/g, "↵")
      .replace(/\t/g, "⇥")
      .replace(/ /g, "\u00a0") + (end < text.length ? "…" : "")
  );
}
export const textPreview = (text: string) =>
  text
    .slice(0, 800)
    .split(/\r\n|\r|\n/)
    .slice(0, 6)
    .join("\n");

export function draftTextBlocks(draft: ComposerDraft): TextBlock[] {
  let offset = 0;
  return draft.parts.flatMap((part) => {
    const start = offset;
    offset += part.text.length;
    return part.kind === "paste" ? [{ id: part.id, start, end: offset }] : [];
  });
}

/**
 * The draft `draftTextBlocks` describes: `text` with each block a paste
 * again, numbered in order (YN-91: how Home keeps a reply's pastes with its
 * text). Blocks that don't fit the text (out of order, overlapping, past its
 * end, or the same id twice) give the text alone: none of it is lost, only
 * its blocks.
 */
export function draftFromTextBlocks(text: string, blocks?: readonly TextBlock[]): ComposerDraft {
  if (!blocks?.length) return textDraft(text);
  const parts: DraftPart[] = [];
  const ids = new Set<string>();
  let offset = 0;
  for (const block of blocks) {
    if (
      typeof block?.id !== "string" || !block.id || ids.has(block.id) ||
      !Number.isInteger(block.start) || !Number.isInteger(block.end) ||
      block.start < offset || block.end < block.start || block.end > text.length
    )
      return textDraft(text);
    ids.add(block.id);
    if (block.start > offset) parts.push({ kind: "text", text: text.slice(offset, block.start) });
    parts.push(pastedText(text.slice(block.start, block.end), ids.size, block.id));
    offset = block.end;
  }
  if (offset < text.length) parts.push({ kind: "text", text: text.slice(offset) });
  return { version: 1, nextNumber: ids.size + 1, parts };
}

export function contentParts(
  text: string,
  blocks?: readonly TextBlock[],
): ContentPart[] {
  if (!blocks)
    return shouldFoldPaste(text)
      ? [{ kind: "long", id: "legacy", text, start: 0, end: text.length }]
      : [{ kind: "text", text }];
  let offset = 0;
  const parts: ContentPart[] = [];
  for (const block of blocks) {
    if (
      !Number.isInteger(block.start) ||
      !Number.isInteger(block.end) ||
      block.start < offset ||
      block.end < block.start ||
      block.end > text.length
    )
      return contentParts(text);
    if (block.start > offset)
      parts.push({ kind: "text", text: text.slice(offset, block.start) });
    parts.push({
      kind: "paste",
      ...block,
      text: text.slice(block.start, block.end),
    });
    offset = block.end;
  }
  if (offset < text.length)
    parts.push({ kind: "text", text: text.slice(offset) });
  return parts;
}

/** Image captions are not part of the text whose offsets the composer saved. */
export function userText(item: NativeItem) {
  return (
    item._yuzunoInputText ??
    (item.content || [])
      .filter((p) => p.type === "text" || p.type === "inputText")
      .map((p) => p.text || "")
      .join("\n")
  );
}

/** Keep attachment-only requests visible without shifting saved text ranges. */
export function userRequestText(item: NativeItem) {
  return [
    userText(item),
    ...(item.content || [])
      .filter((part) => part.type === "image" || part.type === "localImage")
      .map(() => "[Image]"),
  ].filter(Boolean).join("\n");
}
